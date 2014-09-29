// Load modules

var Crypto = require('crypto');
var Fs = require('fs');
var Path = require('path');
var Stream = require('stream');
var Zlib = require('zlib');
var Boom = require('boom');
var Hoek = require('hoek');
var Pez = require('pez');
var Qs = require('qs');
var Wreck = require('wreck');


// Declare internals

var internals = {};


// Read and parse body

exports.read = function (request, next) {

    if (request.method === 'get' || request.method === 'head') {            // When route.method is '*'
        return next();
    }

    // Fail action

    var failActionNext = function (err) {

        if (!err) {
            return next();
        }

        // failAction: 'error', 'log', 'ignore'

        var failAction = request.route.payload.failAction;
        if (failAction !== 'ignore') {
            request.log(['hapi', 'payload', 'error'], err);
        }

        if (failAction === 'error') {
            return next(err);
        }

        return next();
    };

    // Content size

    var req = request.raw.req;
    var contentLength = req.headers['content-length'];
    if (contentLength &&
        parseInt(contentLength, 10) > request.route.payload.maxBytes) {

        return next(Boom.badRequest('Payload content length greater than maximum allowed: ' + request.route.payload.maxBytes));
    }

    // Content type

    var contentType = Pez.contentType(request.route.payload.override || req.headers['content-type'] || 'application/json');     //  Defaults to 'application/json'
    if (contentType.isBoom) {
        return next(contentType);
    }

    var mime = contentType.mime;
    request.mime = mime;

    if (request.route.payload.allow &&
        request.route.payload.allow.indexOf(mime) === -1) {

        return failActionNext(Boom.unsupportedMediaType());
    }

    // Parse: true

    if (request.route.payload.parse === true) {
        return internals.parse(request, contentType, failActionNext);
    }

    // Parse: false, 'gunzip'

    return internals.raw(request, next);
};


internals.parse = function (request, contentType, next) {

    var output = request.route.payload.output;      // Output: 'data', 'stream', 'file'
    var source = request.raw.req;

    // Content-encoding

    var contentEncoding = source.headers['content-encoding'];
    if (contentEncoding === 'gzip' || contentEncoding === 'deflate') {
        var decoder = (contentEncoding === 'gzip' ? Zlib.createGunzip() : Zlib.createInflate());
        next = Hoek.once(next);                                                                     // Modify next() for async events
        decoder.once('error', function (err) {

            return next(Boom.badRequest('Invalid compressed payload', err));
        });

        source = source.pipe(decoder);
    }

    // Tap request

    var tap = request._tap();
    if (tap) {
        source = source.pipe(tap);
    }

    // Multipart

    if (request.mime === 'multipart/form-data') {
        return internals.multipart(request, source, contentType, next);
    }

    // Output: 'stream'

    if (output === 'stream') {
        request.payload = source;
        return next();
    }

    // Output: 'file'

    if (output === 'file') {
        internals.writeFile(source, request.route.payload.uploads, function (err, path, bytes) {

            if (err) {
                return next(err);
            }

            request.payload = { path: path, bytes: bytes };
            return next();
        });

        return;
    }

    // Output: 'data'

    return internals.buffer(request, source, function (err, payload) {

        if (err) {
            return next(err);
        }

        request.payload = {};

        if (!payload.length) {
            return next();
        }

        internals.object(payload, request.mime, function (err, result) {

            if (err) {
                return next(err);
            }

            request.payload = result;
            return next();
        });
    });
};


internals.raw = function (request, next) {

    var output = request.route.payload.output;      // Output: 'data', 'stream', 'file'
    var source = request.raw.req;

    // Content-encoding

    if (request.route.payload.parse === 'gunzip') {
        var contentEncoding = source.headers['content-encoding'];
        if (contentEncoding === 'gzip' || contentEncoding === 'deflate') {
            var decoder = (contentEncoding === 'gzip' ? Zlib.createGunzip() : Zlib.createInflate());
            next = Hoek.once(next);                                                                     // Modify next() for async events
            decoder.once('error', function (err) {

                return next(Boom.badRequest('Invalid compressed payload', err));
            });

            source = source.pipe(decoder);
        }
    }

    // Setup source

    var tap = request._tap();
    if (tap) {
        source = source.pipe(tap);
    }

    // Output: 'stream'

    if (output === 'stream') {
        request.payload = source;
        return next();
    }

    // Output: 'file'

    if (output === 'file') {
        internals.writeFile(source, request.route.payload.uploads, function (err, path, bytes) {

            if (err) {
                return next(err);
            }

            request.payload = { path: path, bytes: bytes };
            return next();
        });

        return;
    }

    // Output: 'data'

    return internals.buffer(request, source, function (err, payload) {

        if (err) {
            return next(err);
        }

        request.payload = payload;
        return next();
    });
};


internals.buffer = function (request, source, next) {

    var parseOptions = {
        timeout: request.server.settings.timeout.client,
        maxBytes: request.route.payload.maxBytes
    };

    Wreck.read(source, parseOptions, next);
};


internals.object = function (payload, mime, next) {

    // Binary

    if (mime === 'application/octet-stream') {
        return next(null, payload);
    }

    // Text

    if (mime.match(/^text\/.+$/)) {
        return next(null, payload.toString('utf8'));
    }

    // JSON

    if (/^application\/(?:.+\+)?json$/.test(mime)) {
        return internals.jsonParse(payload, next);                      // Isolate try...catch for V8 optimization
    }

    // Form-encoded

    if (mime === 'application/x-www-form-urlencoded') {
        return next(null, Qs.parse(payload.toString('utf8')));
    }

    return next(Boom.unsupportedMediaType());
};


internals.jsonParse = function (payload, next) {

    try {
        return next(null, JSON.parse(payload.toString('utf8')));
    }
    catch (err) {
        return next(Boom.badRequest('Invalid request payload JSON format', err));
    }
};


internals.multipart = function (request, source, contentType, next) {

    var options = request.route.payload;
    next = Hoek.once(next);                                            // Modify next() for async events

    var dispenser = new Pez.Dispenser(contentType);

    var onError = function (err) {

        return next(Boom.badRequest('Invalid multipart payload format', err));
    };

    dispenser.once('error', onError);

    var arrayFields = false;
    var finalize = function (data) {

        dispenser.removeListener('error', onError);
        dispenser.removeListener('part', onPart);
        dispenser.removeListener('field', onField);
        dispenser.removeListener('close', onClose);

        if (arrayFields) {
            data = Qs.parse(data);
        }

        request.payload = data;
        return next();
    };

    var data = {};
    var set = function (name, value) {

        arrayFields = arrayFields || (name.indexOf('[') !== -1);

        if (!data.hasOwnProperty(name)) {
            data[name] = value;
        }
        else if (Array.isArray(data[name])) {
            data[name].push(value);
        }
        else {
            data[name] = [data[name], value];
        }
    };

    var pendingFiles = {};
    var nextId = 0;
    var closed = false;

    var onPart = function (part) {

        if (options.output === 'file') {                                                // Output: 'file'
            var id = nextId++;
            pendingFiles[id] = true;
            internals.writeFile(part, options.uploads, function (err, path, bytes) {

                delete pendingFiles[id];

                if (err) {
                    return next(err);
                }

                var item = {
                    filename: part.filename,
                    path: path,
                    headers: part.headers,
                    bytes: bytes
                };

                set(part.name, item);

                if (closed &&
                    !Object.keys(pendingFiles).length) {

                    return finalize(data);
                }
            });
        }
        else {                                                                          // Output: 'data'
            Wreck.read(part, {}, function (err, payload) {

                // err handled by dispenser.once('error')

                if (options.output === 'stream') {                                      // Output: 'stream'
                    var item = Wreck.toReadableStream(payload);

                    item.hapi = {
                        filename: part.filename,
                        headers: part.headers
                    };

                    return set(part.name, item);
                }

                var contentType = part.headers['content-type'] || '';
                var mime = contentType.split(';')[0].trim().toLowerCase();

                if (!mime) {
                    return set(part.name, payload);
                }

                if (!payload.length) {
                    return set(part.name, {});
                }

                internals.object(payload, mime, function (err, result) {

                    return set(part.name, err ? payload : result);
                });
            });
        }
    };

    dispenser.on('part', onPart);

    var onField = function (name, value) {

        set(name, value);
    };

    dispenser.on('field', onField);

    var onClose = function () {

        if (Object.keys(pendingFiles).length) {
            closed = true;
            return;
        }

        return finalize(data);
    };

    dispenser.once('close', onClose);

    source.headers = source.headers || request.headers;
    source.pipe(dispenser);
};


internals.writeFile = function (stream, dest, callback) {

    var path = internals.uniqueFilename(dest);
    var file = Fs.createWriteStream(path, { flags: 'wx' });
    var counter = new internals.Counter();

    var finalize = Hoek.once(function (err) {

        file.removeListener('close', finalize);
        file.removeListener('error', finalize);

        if (!err) {
            return callback(null, path, counter.bytes);
        }

        file.destroy();
        Fs.unlink(path, function (/* fsErr */) {      // Ignore unlink errors

            return callback(err);
        });
    });

    file.once('close', finalize);
    file.once('error', finalize);

    stream.pipe(counter).pipe(file);
};


internals.Counter = function () {

    Stream.Transform.call(this);
    this.bytes = 0;
};

Hoek.inherits(internals.Counter, Stream.Transform);


internals.Counter.prototype._transform = function (chunk, encoding, next) {

    this.bytes += chunk.length;
    return next(null, chunk);
};


internals.uniqueFilename = function (path) {

    var name = [Date.now(), process.pid, Crypto.randomBytes(8).toString('hex')].join('-');
    return Path.join(path, name);
};