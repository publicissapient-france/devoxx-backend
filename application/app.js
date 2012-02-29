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

app.configure(function() {
    app.use(express.static(__dirname + '/public'));
    app.use(express.logger());
    app.use(express.bodyParser());
    app.use(express.cookieParser());
    app.use(express.session({secret: cf.app.instance_id}));
    app.use(express.logger());
    app.use(express.methodOverride());
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

// var redisClient = redis.createClient(redisConfig.port, redisConfig.hostname);
// var redisPublisher = redis.createClient(redisConfig.port, redisConfig.hostname);
// if(redisConfig.password) {
//	 redisClient.auth(redisConfig.password);
//	 redisPublisher.auth(redisConfig.password);
// }

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

app.get('/', function(req, res) {
    console.log('File path: ' + __dirname + '/www/index.html');
    res.sendfile(__dirname + '/www/index.html');
});

app.get('/index.html', function(req, res) {
    res.sendfile(__dirname + '/www/index.html');
});

app.post('/register', function(req, res) {
    mysqlClient.query(
        'insert into registration (firstname, lastname, email) values (?, ?, ?)',
        [ req.body.firstname, req.body.lastname, req.body.email ],
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

//app.post('/load-redis-data', function(req, res) {
//    console.log('Processing JSON request');
//    _.each(req.body, function(entry) {
//        console.log("Inserting Entry: [" + entry.key + ", " + entry.value + "]");
//        redisClient.set(entry.key, entry.value);
//    });
//    res.header('Content-Type', 'application/json');
//    res.send({ count: req.body.length });
//});




app.get('/speaker/:id', function(req, res) {

    var cacheKey = "/data/image/speakers/" + req.params.id;
    var urlToFetch = cacheKey + getParameterByName(req.url, '_');

    console.log("[" + cacheKey + "] Cache Key: " + cacheKey);
    console.log("[" + cacheKey + "] Checking if data is in cache");

    var clearCache = getParameterByName(req.url, 'clear') === 'true';
    var forceNoCache = getParameterByName(req.url, 'cache') === 'false';

    var options = {
        speakerId: req.params.id,
        cacheKey: cacheKey,
        req: req,
        res: res,
        forceNoCache: forceNoCache,
        clearCache: clearCache
    };

    if (options.clearCache) {
        console.log("[" + options.url + "] Clearing cache for key: '" + options.cacheKey + "'");
        imageUriCache[options.cacheKey] = undefined;
     }

    processSpeakerImage( options, function(data) {
        options.res.redirect(data.imageURI);

        if (!options.forceNoCache) {
            imageUriCache[options.cacheKey] = datagit .imageURI;
        }
    } );

});

function processSpeakerImage(options, callback) {
    try {
        if (!options.forceNoCache && imageUriCache[options.cacheKey]) {
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
                    if ( data.imageURI === "http://cfp.devoxx.com/img/thumbnail.gif" || data.imageURI === "https://cfp.devoxx.com/img/thumbnail.gif" ) {
                        callback({ imageURI: "https://cfp.devoxx.com/img/thumbnail.gif" });
                    }
                    else {
                        console.log("[" + options.url + "] Fetched Response from url '" + targetUrl + "': " + data.imageURI);
                        request(data.imageURI, function(err, response, body) {
                            var imageUriValid = response.statusCode !== 200 || response.header("Content-Type").indexOf("image") === -1;
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


app.all('/*', function(req, res) {
    try {

        if (req.method !== 'GET') {
            var errorMessage = "Request method not supported: '" + req.method + "'";
            console.log(errorMessage);
            res.send(errorMessage, 501);
            return;
        }

        var cacheKey = removeParameters(req.url, ['callback', '_']);
        var urlToFetch = removeParameters(req.url, ['callback']);

        console.log("[" + cacheKey + "] Cache Key: " + cacheKey);
        console.log("[" + cacheKey + "] Checking if data is in cache");

        var clearCache = getParameterByName(req.url, 'clear') === 'true';
        var forceNoCache = getParameterByName(req.url, 'cache') === 'false';
        if (forceNoCache) {
            var options = {
                req: req,
                res: res,
                url: urlToFetch,
                cacheKey: cacheKey,
                forceNoCache: forceNoCache,
                clearCache: clearCache
            };
            processRequest(options);
        }
        else {
            redisClient.get(cacheKey, function (err, data) {
                var options = {
                    req: req,
                    res: res,
                    cachedData: data,
                    err: err,
                    url: urlToFetch,
                    cacheKey: cacheKey,
                    forceNoCache: forceNoCache,
                    clearCache: clearCache
                };
                processRequest(options);
            });
        }
    }
    catch(err) {
        errorMessage = err.name + ": " + err.message;
        console.log(errorMessage);
        res.send(errorMessage, 500);
    }
});

function processRequest(options) {
    try {
        if (!options.forceNoCache && options.clearCache) {
            console.log("[" + options.url + "] Clearing cache for key: '" + options.cacheKey + "'");
             redisClient.del(options.cacheKey);
         }

        if (!options.err && options.cachedData) {
            console.log("[" + options.url + "] A reply is in cache key: '" + options.cacheKey + "', returning immediatly the reply");
            sendJsonResponse(options, options.cachedData);
        }
        else {
            console.log("[" + options.url + "] No cached reply found for key: '" + options.cacheKey + "'");
            var targetUrl = 'https://cfp.devoxx.com' + options.cacheKey;
            console.log("[" + options.url + "] Fetching data from url: '" + targetUrl + "'");
            restler.get(targetUrl).on('complete', function (data, response) {
                var contentType = response.header("Content-Type");
                console.log("[" + options.url + "] Http Response - Content-Type: " + contentType);
                if ( contentType.indexOf('json') === -1 &&
                     contentType.indexOf('script') === -1 ) {

                    console.log("[" + options.url + "] Content-Type is not json or javascript: Not caching data and returning response directly");
                    options.res.header('Content-Type', contentType);
                    if (data.indexOf("Entity Not Found") >= 0) {
                        sendJsonResponse(options, '{"statusCode": 404, "message": "Entity Not Found"}');
                    }
                    else {
                        options.res.send(data);
                    }
                }
                else {
                    var jsonData =  JSON.stringify(data);
                    console.log("[" + options.url + "] Fetched Response from url '" + targetUrl + "': " + jsonData);
                    sendJsonResponse(options, jsonData);
                    if (!options.forceNoCache) {
                        redisClient.set(options.cacheKey, jsonData);
//                        client.expire(options.cacheKey, 60 * 60);
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