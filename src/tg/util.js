var config = require('../config');
var nickcolor = require('./nickcolor');
var nodeStatic = require('node-static');
var fs = require('fs');
var path = require('path');
var osHomedir = require('os-homedir');
var mkdirp = require('mkdirp');
var crypto = require('crypto');
var logger = require('winston');
var imgur = require('imgur');
var os = require('os');

var Streamable = require('streamable-js').Streamable;
var STATUS_CODE = require('streamable-js').STATUS_CODE;

if (config.uploadToImgur) {
    imgur.setClientId(config.imgurClientId);
}

var chatIdsPath = path.join(osHomedir(), '.teleirc');

exports.readChatId = function(channel) {
    var chatId;
    var chatIdPath = path.join(chatIdsPath, channel.tgGroup + '.chatid');

    try {
        chatId = JSON.parse(fs.readFileSync(chatIdPath));
        logger.info('successfully read chat ID for group ' + channel.tgGroup);
    } catch (e) {
        logger.error('while reading chat ID for group ' + channel.tgGroup);
    }

    if (!chatId) {
        logger.warn('NOTE!');
        logger.warn('=====');
        logger.warn('Please add your Telegram bot to a Telegram group and have');
        logger.warn('someone send a message to that group.');
        logger.warn('teleirc will then automatically store your group chat_id.');
    }

    return chatId;
};

exports.writeChatId = function(channel) {
    var chatId = JSON.stringify(channel.tgChatId);
    var chatIdPath = path.join(chatIdsPath, channel.tgGroup + '.chatid');

    try {
        fs.writeFileSync(chatIdPath, chatId);
        logger.info('successfully stored chat ID in ' + chatIdPath);
    } catch (e) {
        logger.error('error while storing chat ID:', e);
    }
};

exports.getName = function(user, config) {
    var name = config.nameFormat;

    if (user.title) { // channels
        name = name.replace('%username%', user.title, 'g');
    } else if (user.username) {
        name = name.replace('%username%', user.username, 'g');
    } else {
        // if user lacks username, use fallback format string instead
        name = name.replace('%username%', config.usernameFallbackFormat, 'g');
    }

    name = name.replace('%firstName%', user.first_name || '', 'g');
    name = name.replace('%lastName%', user.last_name || '', 'g');

    // get rid of leading and trailing whitespace
    name = name.replace(/(^\s*)|(\s*$)/g, '');

    if (config.nickcolor) {
        return nickcolor(name);
    }

    return name;
};

exports.getIRCName = function(msg, config) {
    var ircNickMatchRE = /^<(.*)>/;
    var results = ircNickMatchRE.exec(msg.text);
    var name;
    if (!results) {
        // Fall back to telegram name (i.e. for the topic change message)
        name = exports.getName(msg.from || msg.forward_from, config);
    } else {
        name = results[1];
    }

    return name;
};

exports.randomValueBase64 = function(len) {
    return crypto.randomBytes(Math.ceil(len * 3 / 4))
        .toString('base64')
        .slice(0, len)
        .replace(/\+/g, '0')
        .replace(/\//g, '0');
};

exports.serveFile = function(fileId, config, tg, callback) {
    var filesPath = path.join(osHomedir(), '.teleirc', 'files');

    var randomString = exports.randomValueBase64(config.mediaRandomLength);
    mkdirp(path.join(filesPath, randomString));
    tg.downloadFile(fileId, path.join(filesPath, randomString))
    .then(function(filePath) {
        callback(config.httpLocation + '/' + randomString + '/' + path.basename(filePath));
    });
};

exports.uploadToImgur = function(fileId, config, tg, callback) {
    var filesPath = os.tmpdir();
    var randomString = exports.randomValueBase64(config.mediaRandomLength);
    mkdirp(path.join(filesPath, randomString));
    tg.downloadFile(fileId, path.join(filesPath, randomString))
    .then(function(filePath) {
            imgur.uploadFile(filePath)
            .then(function(json) {
                callback(json.data.link);
            });
        });
};

exports.uploadToStreamable = function(msg, config, tg, callback) {
    var file_id;
    var file_size;
    if ('document' in msg) {
        file_id = msg.document.file_id;
        file_size = msg.document.file_size;
    } else {
        file_id = msg.video.file_id;
        file_size = msg.video.file_size;
    }
    // "Video files must be smaller than 10GB in size
    // and 10 minutes in length."
    if (msg.video.duration > 60 * 10 ||
        file_size > 10000000000) {
        return;
    }
    var filesPath = os.tmpdir();
    var randomString = exports.randomValueBase64(config.mediaRandomLength);
    mkdirp(path.join(filesPath, randomString));
    tg.downloadFile(file_id, path.join(filesPath, randomString))
    .then(function(filePath) {
        var streamable = new Streamable();
        streamable.uploadVideo(filePath, msg.caption).then(function(resp) {
            streamable.waitFor(resp.shortcode, STATUS_CODE.READY)
            .then(function(resp) {
                callback('http://' + resp.url);
            });
        });
    });

};

exports.initHttpServer = function() {
    var filesPath = path.join(osHomedir(), '.teleirc', 'files');
    mkdirp(filesPath);

    var fileServer = new nodeStatic.Server(filesPath);

    require('http').createServer(function(req, res) {
        req.addListener('end', function() {
            fileServer.serve(req, res);
        }).resume();
    }).listen(config.httpPort);
};

// reconstructs the original raw markdown message
var reconstructMarkdown = function(msg) {
    if (!msg.entities) {
        return;
    }

    var incrementOffsets = function(from, by) {
        msg.entities.forEach(function(entity) {
            if (entity.offset > from) {
                entity.offset += by;
            }
        });
    };

    // example markdown:
    // pre `txt` end
    var pre; // contains 'pre '
    var txt; // contains 'txt'
    var end; // contains ' end'

    msg.entities.forEach(function(entity) {
        switch (entity.type) {
            case 'text_link': // [text](url)
                pre = msg.text.substr(0, entity.offset);
                txt = msg.text.substr(entity.offset, entity.length);
                end = msg.text.substr(entity.offset + entity.length);

                msg.text = pre + '[' + txt + ']' + '(' + entity.url + ')' + end;
                incrementOffsets(entity.offset, 4 + entity.url);
                break;
            case 'code': // ` code
                pre = msg.text.substr(0, entity.offset);
                txt = msg.text.substr(entity.offset, entity.length);
                end = msg.text.substr(entity.offset + entity.length);

                msg.text = pre + '`' + txt + '`' + end;
                incrementOffsets(entity.offset, 2);
                break;
            case 'pre': // ``` code blocks
                pre = msg.text.substr(0, entity.offset);
                txt = msg.text.substr(entity.offset, entity.length);
                end = msg.text.substr(entity.offset + entity.length);

                msg.text = pre + '```' + txt + '```' + end;
                incrementOffsets(entity.offset, 6);
                break;
            case 'hashtag': // #hashtags can be passed on as is
                break;
            default:
                logger.warn('unsupported entity type:', entity.type, msg);
        }
    });
};

exports.msgIsVideo = function(msg) {
    return msg.video || (msg.document && msg.document.mime_type.startsWith('video/'));
};

exports.parseMsg = function(msg, myUser, tg, callback) {
    // TODO: Telegram code should not have to deal with IRC channels at all

    var channel = config.channels.filter(function(channel) {
        return channel.tgGroup === msg.chat.title;
    })[0];

    if (!channel) {
        logger.verbose('Telegram group not found in config: "' +
                    msg.chat.title + '", dropping message...');
        return callback();
    }

    // check if message contains a migrate command
    if (msg.migrate_to_chat_id) {
        logger.info('chat migrated to supergroup.');
        channel.tgChatId = msg.migrate_to_chat_id;
        exports.writeChatId(channel);
        logger.info('stored new chatId');
        return callback();
    } else if (!channel.tgChatId) {
        logger.info('storing chat ID: ' + msg.chat.id);
        channel.tgChatId = msg.chat.id;
        exports.writeChatId(channel);
    }

    var age = Math.floor(Date.now() / 1000) - msg.date;
    if (config.maxMsgAge && age > config.maxMsgAge) {
        logger.warn('skipping ' + age + ' seconds old message! ' +
            'NOTE: change this behaviour with config.maxMsgAge, also check your system clock');
        return callback();
    }

    // skip posts containing media if it's configured off
    if ((msg.audio || msg.document || msg.photo || msg.sticker || msg.video ||
                msg.voice || msg.contact || msg.location) && !config.showMedia) {
        // except if the media object is an photo and imgur uploading is
        // enabled
        if (!((msg.photo && config.uploadToImgur) ||
            (config.uploadToStreamable && exports.msgIsVideo(msg)))) {
            return callback();
        }
    }

    var prefix = '';
    if (!config.soloUse) {
        prefix = '<' + exports.getName(msg.from, config) + '> ';
    }

    if (msg.text && !msg.text.indexOf('/names')) {
        return callback({
            channel: channel,
            cmd: 'getNames'
        });
    } else if (msg.text && !msg.text.indexOf('/topic')) {
        return callback({
            channel: channel,
            cmd: 'getTopic'
        });
    } else if (msg.text && !msg.text.indexOf('/version')) {
        return callback({
            channel: channel,
            cmd: 'getVersion'
        });
    } else if (msg.text && !msg.text.indexOf('/command')) {
        var command = msg.text.split(' ');
        command.shift();
        command = command.join(' ');

        return callback({
            channel: channel,
            cmd: 'sendCommand',
            text: command,
            origText: prefix + msg.text
        });
    } else if (msg.text && !msg.text.indexOf('/me')) {
        var text = msg.text.split(' ');
        text.shift();
        text = text.join(' ');

        text = '* ' + exports.getName(msg.from, config) + ' ' + text;

        return callback({
            channel: channel,
            text: text
        });
    } else if (msg.text && !msg.text.indexOf('/')) { // drop other commands
        logger.verbose('ignoring unknown command:', msg.text);
        return;
    }

    if (msg.text) {
        reconstructMarkdown(msg);
    }

    if (msg.reply_to_message && msg.text) {
        var replyName;

        // is the replied to message originating from the bot?
        if (msg.reply_to_message.from.username == myUser.username) {
            replyName = exports.getIRCName(msg.reply_to_message, config);
        } else {
            replyName = exports.getName(msg.reply_to_message.from, config);
        }

        callback({
            channel: channel,
            text: prefix + '@' + replyName + ', ' + msg.text
        });
    } else if ((msg.forward_from || msg.forward_from_chat) && msg.text) {
        var from = msg.forward_from || msg.forward_from_chat;
        var fwdName;

        // is the forwarded message originating from the bot?
        if (from.username == myUser.username) {
            fwdName = exports.getIRCName(msg, config);
        } else {
            fwdName = exports.getName(from, config);
        }

        callback({
            channel: channel,
            text: prefix + 'Fwd from ' + fwdName + ': ' + msg.text
        });
    } else if (msg.audio) {
        exports.serveFile(msg.audio.file_id, config, tg, function(url) {
            callback({
                channel: channel,
                text: prefix + '(Audio, ' + msg.audio.duration + 's)' + url
            });
        });
    } else if (msg.document) {
        if (config.uploadToStreamable && msg.document.mime_type.startsWith('video/')) {
            exports.uploadToStreamable(msg, config, tg, function(url) {
                callback({
                    channel: channel,
                    text: prefix + '(Video) ' +
                    url + (msg.caption ? ' ' + msg.caption : '')
                });});
        } else {
            exports.serveFile(msg.document.file_id, config, tg, function(url) {
                callback({
                    channel: channel,
                    text: prefix + '(Document) ' + url
                });
            });
        }
    } else if (msg.photo) {
        // pick the highest quality photo
        var photo = msg.photo[msg.photo.length - 1];
        if (config.uploadToImgur) {
            exports.uploadToImgur(photo.file_id, config, tg, function(url) {
                callback({
                    channel: channel,
                    text: prefix + '(Photo, ' + photo.width + 'x' + photo.height + ') ' +
                    url + (msg.caption ? ' ' + msg.caption : '')
                });
            });
        } else {
            exports.serveFile(photo.file_id, config, tg, function(url) {
                callback({
                    channel: channel,
                    text: prefix + '(Photo, ' + photo.width + 'x' + photo.height + ') ' +
                    url + (msg.caption ? ' ' + msg.caption : '')
                });
            });
        }
    } else if (msg.new_chat_photo) {
        // pick the highest quality photo
        var chatPhoto = msg.new_chat_photo[msg.new_chat_photo.length - 1];
        if (config.uploadToImgur) {
            exports.uploadToImgur(chatPhoto.file_id, config, tg, function(url) {
                callback({
                    channel: channel,
                    text: prefix + '(New chat photo, ' +
                    chatPhoto.width + 'x' + chatPhoto.height + ') ' + url
                });});
        } else {
            exports.serveFile(chatPhoto.file_id, config, tg, function(url) {
                callback({
                    channel: channel,
                    text: prefix + '(New chat photo, ' +
                    chatPhoto.width + 'x' + chatPhoto.height + ') ' + url
                });
            });
        }
    } else if (msg.sticker) {
        exports.serveFile(msg.sticker.file_id, config, tg, function(url) {
            callback({
                channel: channel,
                text: prefix + '(Sticker, ' +
                        msg.sticker.width + 'x' + msg.sticker.height + ') ' + url
            });
        });
    } else if (msg.video) {
        if (config.uploadToStreamable) {
            exports.uploadToStreamable(msg, config, tg, function(url) {
                callback({
                    channel: channel,
                    text: prefix + '(Video, ' + msg.video.duration + 's) ' +
                    url + (msg.caption ? ' ' + msg.caption : '')
                });
            });
        } else {
            exports.serveFile(msg.video.file_id, config, tg, function(url) {
                callback({
                    channel: channel,
                    text: prefix + '(Video, ' + msg.video.duration + 's) ' +
                      url + (msg.caption ? ' ' + msg.caption : '')
                });
            });
        }
    } else if (msg.voice) {
        exports.serveFile(msg.voice.file_id, config, tg, function(url) {
            callback({
                channel: channel,
                text: prefix + '(Voice, ' + msg.voice.duration + 's) ' + url
            });
        });
    } else if (msg.contact) {
        callback({
            channel: channel,
            text: prefix + '(Contact, ' + '"' + msg.contact.first_name + ' ' +
                    msg.contact.last_name + '", ' +
                    msg.contact.phone_number + ')'
        });
    } else if (msg.location) {
        callback({
            channel: channel,
            text: prefix + '(Location, ' + 'lon: ' + msg.location.longitude +
                    ', lat: ' + msg.location.latitude + ')'
        });
    } else if (msg.new_chat_participant) {
        callback({
            channel: channel,
            text: exports.getName(msg.new_chat_participant, config) +
                ' was added by: ' + exports.getName(msg.from, config)
        });
    } else if (msg.left_chat_participant) {
        callback({
            channel: channel,
            text: exports.getName(msg.left_chat_participant, config) +
                ' was removed by: ' + exports.getName(msg.from, config)
        });
    } else if (msg.text) {
        callback({
            channel: channel,
            text: prefix + msg.text
        });
    } else {
        logger.warn('WARNING: unhandled message:', msg);
        callback();
    }
};
