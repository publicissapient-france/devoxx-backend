var request = require('request');
var fs = require('fs');
var express = require('express');
var restler = require('restler');
var util = require('util');
var path = require('path');
var redis = require("redis");
var mysql = require('mysql');
var underscore = require("underscore");
var cf = require("cloudfoundry");

var PRE_CACHE_SPEAKERS = false;
var OFFLINE = false;
var EXPIRE_CACHE = true;
var USE_CACHE = true;

var _ = underscore._;

var imageUriCache = {};

if(!cf.app) {

   var LOCAL_CF_CONFIG = {
       cloud: false,
       host: 'localhost',
       port: 9000,
       app: {
           instance_id: '7bcc459686eda42a8d696b3b398ed6d1',
           instance_index: 0,
           name: 'devoxx-data',
           uris: ['devoxx-data.cloudfoundry.com'],
           users: ['akinsella@xebia.fr'],
           version: '11ad1709af24f01286b2799bc90553454cdb96c6-1',
           start: '2012-02-23 19:23:39 +0000',
           runtime: 'node',
           state_timestamp: 1324796219,
           port: 9000,
           limits: {
               fds: 256,
               mem: 134217728,
               disk: 2147483648
           },
           host:'localhost'
       },
       services: {
           'redis-2.2': [{
                   name: 'devoxx-data-redis',
                   label: 'redis-2.2',
                   plan: 'free',
                   credentials: {
                       node_id: 'redis_node_2',
                       host: 'localhost',
                       hostname: 'localhost',
                       port: 6379,
                       password: '',
                       name: 'devoxx-data',
                       username: 'devoxx-data'
                   },
                   version: '2.2'
               }],
               'mysql-5.1': [{
                   name: 'devoxx-data-mysql',
                   label: 'mysql-5.1',
                   plan: 'free',
                   tags:["mysql","mysql-5.1","relational"],
                   credentials: {
                       node_id: 'mysql_node_4',
                       host: 'localhost',
                       hostname: 'localhost',
                       port: 3306,
                       password: 'devoxx-data',
                       name: 'devoxx-data',
                       user: 'devoxx-data',
                       username: 'devoxx-data'
                   },
                   version: '5.1'
               }]
       }
   };

   cf = _.extend(cf, LOCAL_CF_CONFIG);
}

var app = express.createServer();

var redisConfig = cf.services["redis-2.2"][0];
var mysqlConfig = cf.services["mysql-5.1"][0];

console.log('Application Name: ' + cf.app.name);
console.log('Env: ' + JSON.stringify(cf));

var allowCrossDomain = function(req, res, next) {
    res.header('Access-Control-Allow-Origin', "*");
    res.header('Access-Control-Allow-Methods', 'GET,POST');
    res.header('Access-Control-Allow-Headers', 'Content-Type');

    next();
};

app.configure(function() {
    app.use(express.static(__dirname + '/public'));
    app.use(express.logger());
    app.use(express.bodyParser());
    app.use(express.cookieParser());
    app.use(express.session({secret: cf.app.instance_id}));
    app.use(express.logger());
    app.use(express.methodOverride());
    app.use(allowCrossDomain);
    app.set('running in cloud', cf.cloud);

    app.use(app.router);
});


app.configure('development', function () {
    app.use(express.errorHandler({ dumpExceptions:true, showStack:true }));
});

app.configure('production', function () {
    app.use(express.errorHandler());
});

var mysqlOptions = {
    host: mysqlConfig.credentials.hostname,
    port: mysqlConfig.credentials.port,
    database: mysqlConfig.credentials.name,
    user: mysqlConfig.credentials.user,
    password: mysqlConfig.credentials.password,
    debug: false
};

var mysqlClient = mysql.createClient(mysqlOptions);
console.log('Env: ' + JSON.stringify(mysqlOptions));

redis.debug_mode = false;

var redisClient = redis.createClient( redisConfig.credentials.port, redisConfig.credentials.hostname );

if (redisConfig.credentials.password) {
    redisClient.auth(redisConfig.credentials.password, function(err, res) {
        console.log("Authenticating to redis!");
    });
}

process.on('SIGTERM', function () {
    console.log('Got SIGTERM exiting...');
    // do some cleanup here
    process.exit(0);
});

// var appPort = cf.getAppPort() || 9000;
var appPort = cf.port || 9000;
console.log("Express listening on port: " + appPort);
app.listen(appPort);

redisClient.on("error", function (err) {
    console.log("Error " + err);
});

console.log("Initializing devoxx cache application");

function removeParameters(url, parameters) {

  for (var id = 0 ; id < parameters.length ; id++) {
      var urlparts= url.split('?');

      if (urlparts.length>=2)
      {
          var urlBase=urlparts.shift(); //get first part, and remove from array
          var queryString=urlparts.join("?"); //join it back up

          var prefix = encodeURIComponent(parameters[id])+'=';
          var pars = queryString.split(/[&;]/g);
          for (var i= pars.length; i-->0;)               //reverse iteration as may be destructive
              if (pars[i].lastIndexOf(prefix, 0)!==-1)   //idiom for string.startsWith
                  pars.splice(i, 1);
          var result = pars.join('&');
          url = urlBase + (result ? '?' + result : '');
      }
  }

  return url;
}

function getParameterByName( url, name ) {
    name = name.replace(/[\[]/,"\\\[").replace(/[\]]/,"\\\]");
    var regex = new RegExp( "[\\?&]" + name + "=([^&#]*)" );
    var results = regex.exec( url );
    if( results == null ) {
        return "";
    }
    else {
        return decodeURIComponent(results[1].replace(/\+/g, " "));
    }
}

function sendJsonResponse(options, data) {

    var callback = getParameterByName(options.req.url, 'callback');

    var response = data;
    if (callback) {
        options.res.header('Content-Type', 'application/javascript');
        response = callback + '(' + response + ');';
    }
    else {
        options.res.header('Content-Type', 'application/json');
    }

    console.log("[" + options.url + "] Response sent: " + response);
    options.res.send(response);
}

function getContentType(response) {
    return response.header("Content-Type");
}

function isContentTypeJsonOrScript(contentType) {
    return contentType.indexOf('json') >= 0 || contentType.indexOf('script') >= 0;
}

function getCacheKey(req) {
    return removeParameters(req.url, ['callback', '_']);
}

function getUrlToFetch(req) {
    return removeParameters(req.url, ['callback']);
}

function getIfUseCache(req) {
    return getParameterByName(req.url, 'cache') === 'false';
}

function useCache(options) {
    return !options.forceNoCache && USE_CACHE;
}

app.get('/', function(req, res) {
    console.log('File path: ' + __dirname + '/www/index.html');
    res.sendfile(__dirname + '/www/index.html');
});

app.get('/index.html', function(req, res) {
    res.sendfile(__dirname + '/www/index.html');
});

app.post('/register', function(req, res) {
    mysqlClient.query(
        'insert into registration (firstname, lastname, email, pass_id, comment) values (?, ?, ?, ?, ?)',
        [
            req.body.firstname || "",
            req.body.lastname || "",
            req.body.email || "",
            req.body.pass_id || "",
            req.body.comment || ""
        ],
        function selectCb(err, results, fields) {
            if (err) {
                var errorMessage = err.name + ": " + err.message;
                console.log(errorMessage);
                res.send(errorMessage, 500);
            }
            else {
                res.send('success');
            }
        });
});

app.all('/register', function(req, res) {
    res.send("Only HTTP POST requests accepted", 401);
});

//app.post('/load-redis-data', function(req, res) {
//    console.log('Processing JSON request');
//    _.each(req.body, function(entry) {
//        console.log("Inserting Entry: [" + entry.key + ", " + entry.value + "]");
//        redisClient.set(entry.key, entry.value);
//    });
//    res.header('Content-Type', 'application/json');
//    res.send({ count: req.body.length });
//});

app.get('/redis-nuke', function(req, res) {
    console.log('Removing all keys');
    redisClient.keys("*", function (err, data) {
         if (!err && data) {
             res.send(data);
             redisClient.del(data, function (dataDel) {
                 res.send("Done: " + dataDel);
             } );
         }
    });
});

if (OFFLINE) {

    app.get('/twitter/*', function (req, res) {

        request("http://localhost/devoxx-2012/data/twitter/user_timeline.json", function(err, response, body) {
                var callback = getParameterByName(req.url, 'callback');
                res.header('Content-Type', 'application/javascript');
                res.send(callback + "(" + body + ");");
         });

    });

    app.get('/rest/v1/events/6/schedule/day/:id', function (req, res) {
        var dayId = Number(req.params.id);
        if (_([1, 2, 3]).contains(dayId)) {
            request("http://localhost/devoxx-2012/data/schedule/day/" + req.params.id + ".json", function(err, response, body) {
                    var callback = getParameterByName(req.url, 'callback');
                    res.header('Content-Type', 'application/javascript');
                    res.send(callback + "(" + body + ");");
             });
        }
        else {
            res.send("Not Found - Bad day id: " + dayId, 404);
        }

    });

    app.get('/rest/v1/events/6/schedule/rooms', function (req, res) {

        request("http://localhost/devoxx-2012/data/schedule/rooms.json", function(err, response, body) {
                var callback = getParameterByName(req.url, 'callback');
                res.header('Content-Type', 'application/javascript');
                res.send(callback + "(" + body + ");");
         });

    });

    app.get('/rest/v1/events/6/schedule', function (req, res) {

        request("http://localhost/devoxx-2012/data/schedule/schedule.json", function(err, response, body) {
                var callback = getParameterByName(req.url, 'callback');
                res.header('Content-Type', 'application/javascript');
                res.send(callback + "(" + body + ");");
         });

    });

    app.get('/speaker/*', function (req, res) {

        res.header('Content-Type', 'image/png');
        res.sendfile(__dirname + '/public/images/speaker/default.png');

    });

    app.get('/rest/v1/events/6/speakers', function (req, res) {

        request("http://localhost/devoxx-2012/data/speaker/speakers.json", function(err, response, body) {
                var callback = getParameterByName(req.url, 'callback');
                res.header('Content-Type', 'application/javascript');
                res.send(callback + "(" + body + ");");
         });

    });

    app.get('/rest/v1/events/speakers/*', function (req, res) {

        request("http://localhost/devoxx-2012/data/speaker/speaker.json", function(err, response, body) {
                var callback = getParameterByName(req.url, 'callback');
                res.header('Content-Type', 'application/javascript');
                res.send(callback + "(" + body + ");");
         });

    });

    app.get('/rest/v1/events/4/presentations', function (req, res) {

        request("http://localhost/devoxx-2012/data/presentations/presentations.json", function(err, response, body) {
                var callback = getParameterByName(req.url, 'callback');
                res.header('Content-Type', 'application/javascript');
                res.send(callback + "(" + body + ");");
         });

    });

     app.get('/rest/v1/events/presentations/*', function (req, res) {

         request("http://localhost/devoxx-2012/data/presentation/presentation.json", function(err, response, body) {
                 var callback = getParameterByName(req.url, 'callback');
                 res.header('Content-Type', 'application/javascript');
                 res.send(callback + "(" + body + ");");
          });

     });

}

app.get('/xebia/program', function(req, res) {

    request("http://devoxx.helyx.org/data/xebia-program.json", function(err, response, body) {
            var callback = getParameterByName(req.url, 'callback');
            res.header('Content-Type', 'application/javascript');
            res.send(callback + "(" + body + ");");
     });

});

app.get('/speaker/:id', function(req, res) {

    var cacheKey = "/data/image/speakers/" + req.params.id;

    console.log("[" + cacheKey + "] Cache Key: " + cacheKey);
    console.log("[" + cacheKey + "] Checking if data is in cache");

    var forceNoCache = getParameterByName(req.url, 'cache') === 'false';

    var options = {
        speakerId: req.params.id,
        cacheKey: cacheKey,
        req: req,
        res: res,
        forceNoCache: forceNoCache
    };

    processSpeakerImage( options, function(data) {
        options.res.redirect(data.imageURI);

        if (useCache(options)) {
            console.log("Adding image '" + data.imageURI + "' for speaker: '" + data.id + "'");
            imageUriCache[options.cacheKey] = data.imageURI;
        }
    } );

});

function processSpeakerImage(options, callback) {
    try {
        if (useCache(options) && imageUriCache[options.cacheKey]) {
            callback({ imageURI: imageUriCache[options.cacheKey] });
        }
        else {
            console.log("[" + options.url + "] No cached reply found for key: '" + options.cacheKey + "'");
            var targetUrl = 'https://cfp.devoxx.com/rest/v1/events/speakers/' + options.speakerId;
            console.log("[" + options.url + "] Fetching data from url: '" + targetUrl + "'");
            restler.get(targetUrl).on('complete', function (data, response) {
                var contentType = response.header("Content-Type");
                console.log("[" + options.url + "] Http Response - Content-Type: " + contentType);
                if ( contentType.indexOf('json') === -1 && contentType.indexOf('script') === -1 ) {
                    console.log("[" + options.url + "] Content-Type is not json or javascript: Not caching data and returning response directly");
                    callback({ imageURI: "https://cfp.devoxx.com/img/thumbnail.gif" });
                }
                else {
                    if ( data.imageURI && data.imageURI.indexOf(".devoxx.com/img/thumbnail.gif") >= 0 ) {
                        callback({ imageURI: "https://cfp.devoxx.com/img/thumbnail.gif" });
                    }
                    else {
                        console.log("[" + options.url + "] Fetched Response from url '" + targetUrl + "': " + data.imageURI);
                        request(data.imageURI, function(err, response, body) {
                            var imageUriValid = response.statusCode === 200 && response.header("Content-Type").indexOf("image") !== -1;
                            callback({ imageURI: imageUriValid ? data.imageURI : "https://cfp.devoxx.com/img/thumbnail.gif" });
                        });
                    }
                }
            });
        }
    } catch(err) {
        var errorMessage = err.name + ": " + err.message;
        console.log(errorMessage);
        options.res.send(errorMessage, 500);
    }
}

app.get('/rest/v1/events/:eventId/tracks/:trackId', function (req, res) {

    var eventId = req.params.eventId;
    console.log("EventId: " + eventId);
    var trackId = req.params.trackId;
    console.log("TrackId: " + trackId);
    var tracksUrl = "/rest/v1/events/" + eventId + "/tracks";
    var presentationsUrl = "/rest/v1/events/" + eventId + "/presentations";
    console.log("Presentations Url: " + presentationsUrl);

    getDevoxxData({
        req: req,
        res: res,
        url: tracksUrl,
        cacheKey: tracksUrl,
        forceNoCache: getIfUseCache(req),
        callback: onTracksDataLoaded,
        trackId: trackId,
        eventId: eventId
    });

    function onTracksDataLoaded(statusCode, statusMessage, tracks, options) {
        if (statusCode !== 200) {
            responseData(statusCode, statusMessage, tracks, options);
        }
        else {
            getDevoxxData({
                req: req,
                res: res,
                url: presentationsUrl,
                cacheKey: presentationsUrl,
                forceNoCache: getIfUseCache(req),
                callback: onPresentationsLoaded,
                tracks: tracks
            });
        }
    }

    function onPresentationsLoaded(statusCode, statusMessage, presentations, options) {
        if (statusCode !== 200) {
            responseData(statusCode, statusMessage, presentations, options);
        }
        else {
            var track = _(JSON.parse(options.tracks)).find(function(track) {
                return track.id === Number(trackId);
            });
            var trackPresentations = _(JSON.parse(presentations)).filter(function(presentation) { return presentation.track === track.name; });
            responseData(statusCode, statusMessage, JSON.stringify(trackPresentations), options)
        }
    }

});

app.get('/rest/v1/events/:eventId/rooms/:roomId', function (req, res) {

    var eventId = req.params.eventId;
    console.log("EventId: " + eventId);
    var roomId = req.params.roomId;
    console.log("roomId: " + roomId);
    var roomsUrl = "/rest/v1/events/" + eventId + "/schedule/rooms";
    var presentationsUrl = "/rest/v1/events/" + eventId + "/presentations";
    console.log("Presentations Url: " + presentationsUrl);

    getDevoxxData({
        req: req,
        res: res,
        url: roomsUrl,
        cacheKey: roomsUrl,
        forceNoCache: getIfUseCache(req),
        callback: onRoomsDataLoaded,
        roomId: roomId,
        eventId: eventId
    });

    function onRoomsDataLoaded(statusCode, statusMessage, rooms, options) {
        if (statusCode !== 200) {
            responseData(statusCode, statusMessage, rooms, options);
        }
        else {
            getDevoxxData({
                req: req,
                res: res,
                url: presentationsUrl,
                cacheKey: presentationsUrl,
                forceNoCache: getIfUseCache(req),
                callback: onPresentationsLoaded,
                rooms: rooms
            });
        }
    }

    function onPresentationsLoaded(statusCode, statusMessage, presentations, options) {
        if (statusCode !== 200) {
            responseData(statusCode, statusMessage, presentations, options);
        }
        else {
            var room = _(JSON.parse(options.rooms)).find(function(room) {
                return room.id === Number(roomId);
            });
            var roomPresentations = _(JSON.parse(presentations)).filter(function(presentation) { return presentation.room === room.name; });
            responseData(statusCode, statusMessage, JSON.stringify(roomPresentations), options)
        }
    }

});

app.get('/rest/v1/events/:eventId/presentations', function (req, res) {

    var eventId = req.params.eventId;
    console.log("EventId: " + eventId);
    var tracksUrl = "/rest/v1/events/" + eventId + "/tracks";
    var roomsUrl = "/rest/v1/events/" + eventId + "/schedule/rooms";
    var presentationsUrl = "/rest/v1/events/" + eventId + "/presentations";
    console.log("Presentations Url: " + presentationsUrl);

    getDevoxxData({
        req: req,
        res: res,
        url: roomsUrl,
        cacheKey: roomsUrl,
        forceNoCache: getIfUseCache(req),
        callback: onRoomsDataLoaded,
        eventId: eventId
    });

    function onRoomsDataLoaded(statusCode, statusMessage, rooms, options) {
        if (statusCode !== 200) {
            responseData(statusCode, statusMessage, rooms, options);
        }
        else {
            getDevoxxData({
                req: req,
                res: res,
                url: tracksUrl,
                cacheKey: tracksUrl,
                forceNoCache: getIfUseCache(req),
                callback: onTracksDataLoaded,
                rooms: JSON.parse(rooms)
            });
        }
    }

    function onTracksDataLoaded(statusCode, statusMessage, tracks, options) {
        if (statusCode !== 200) {
            responseData(statusCode, statusMessage, tracks, options);
        }
        else {
            getDevoxxData({
                req: req,
                res: res,
                url: presentationsUrl,
                cacheKey: presentationsUrl,
                forceNoCache: getIfUseCache(req),
                callback: onPresentationsLoaded,
                rooms: options.rooms,
                tracks: JSON.parse(tracks)
            });
        }
    }

    function onPresentationsLoaded(statusCode, statusMessage, presentations, options) {
        if (statusCode !== 200) {
            responseData(statusCode, statusMessage, presentations, options);
        }
        else {
            presentations = JSON.parse(presentations);
            _(presentations).each(function(presentation) {
                if (presentation.room) {
                    var room = _(options.rooms).find(function(room) {
                        return room.name == presentation.room;
                    });
                    if (room) {
                        presentation.roomId = room.id;
                    }
                }
                if (presentation.track) {
                    var track = _(options.tracks).find(function(track) {
                        return track.name == presentation.track;
                    });
                    if (track) {
                        presentation.trackId = track.id;
                    }
                }
            });
            responseData(statusCode, statusMessage, JSON.stringify(presentations), options)
        }
    }

});

app.get('/*', function(req, res) {
    getDevoxxData({
        req: req,
        res: res,
        url: getUrlToFetch(req),
        cacheKey: getCacheKey(req),
        forceNoCache: getIfUseCache(req),
        callback: responseData
    });
});

function responseData(statusCode, statusMessage, data, options) {
    if (statusCode === 200) {
        sendJsonResponse(options, data);
    }
    else {
        console.log("Status code: " + statusCode + ", message: " + statusMessage);
        options.res.send(statusMessage, statusCode);
    }
}

function getDevoxxData(options) {
    try {
        if (!useCache(options)) {
            fetchDataFromDevoxxUrl(options);
        }
        else {
            console.log("[" + options.cacheKey + "] Cache Key is: " + options.cacheKey);
            console.log("Checking if data for cache key [" + options.cacheKey + "] is in cache");
            redisClient.get(options.cacheKey, function (err, data) {
                if (!err && data) {
                    console.log("[" + options.url + "] A reply is in cache key: '" + options.cacheKey + "', returning immediatly the reply");
                    options.callback(200, "", data, options);
                }
                else {
                    console.log("[" + options.url + "] No cached reply found for key: '" + options.cacheKey + "'");
                    fetchDataFromDevoxxUrl(options);
                }
            });
        }
    } catch(err) {
        var errorMessage = err.name + ": " + err.message;
        options.callback(500, errorMessage, undefined, options);
    }
}

function fetchDataFromDevoxxUrl(options) {
    var targetUrl = 'https://cfp.devoxx.com' + options.cacheKey;
    console.log("[" + options.url + "] Fetching data from url: '" + targetUrl + "'");
    restler.get(targetUrl).on('complete', function (data, response) {
        var contentType = getContentType(response);
        console.log("[" + options.url + "] Http Response - Content-Type: " + contentType);
        if ( !isContentTypeJsonOrScript(contentType) ) {
            console.log("[" + options.url + "] Content-Type is not json or javascript: Not caching data and returning response directly");
            options.res.header('Content-Type', contentType);
            if (data.indexOf("Entity Not Found") >= 0) {
                var dataToAnswer = '{"statusCode": 404, "message": "Entity Not Found"}';
                options.callback(200, "", dataToAnswer, options);
            }
            else {
                options.callback(200, "", data, options);
            }
        }
        else {
            var jsonData =  JSON.stringify(data);
            console.log("[" + options.url + "] Fetched Response from url '" + targetUrl + "': " + jsonData);
            options.callback(200, "", jsonData, options);
            if (useCache(options)) {
                redisClient.set(options.cacheKey, jsonData);
                if (EXPIRE_CACHE) {
                    redisClient.expire(options.cacheKey, 60 * 60);
                }
            }
        }
    });

}

function initSpeakerCacheData() {
    console.log("Trying to init speaker image URI cache");
    var cacheKey = "/rest/v1/events/6/speakers";
    redisClient.get(cacheKey, function (err, data) {
        if (!err && data) {
            console.log("Data found to init speaker image URI cache");
            _.each(JSON.parse(data), function(speaker) {
                process.nextTick(function() {
                    processSpeakerImage( { speakerId: speaker.id, cacheKey: cacheKey }, function(data) {
                        console.log("Adding image '" + speaker.imageURI + "' for speaker: '" + speaker.id + "'");
                        imageUriCache["/data/image/speakers/" + speaker.id] = data.imageURI;
                    } );
                });
            })
        }
        else {
            console.log("No data available to init speaker image URI cache");
        }
    });
}

if (PRE_CACHE_SPEAKERS) {
    process.nextTick(initSpeakerCacheData);
}