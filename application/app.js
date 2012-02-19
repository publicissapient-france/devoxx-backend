var fs = require('fs'),
    express = require('express'),
    app = express.createServer(),
    restler = require('restler'),
    util = require('util');
var path = require('path');

var redis = require("redis");

var env = {
    DOTCLOUD_SERVICE_NAME: 'Mac Book Pro',
    DOTCLOUD_DATA_REDIS_HOST: 'localhost',
    DOTCLOUD_DATA_REDIS_LOGIN: undefined,
    DOTCLOUD_DATA_REDIS_PASSWORD: "",
    DOTCLOUD_DATA_REDIS_PORT: '6379',
    DOTCLOUD_DATA_REDIS_URL: undefined
};

if (path.existsSync('/home/dotcloud/environment.json')) {
    env = JSON.parse(fs.readFileSync('/home/dotcloud/environment.json', 'utf-8'));
}

console.log('Application Name: ' + env['DOTCLOUD_SERVICE_NAME']);
console.log('Env: ' + JSON.stringify(env));

app.configure(function () {
    app.use(express.static(__dirname + '/www/public'));
    app.use(express.logger());
    app.use(express.bodyParser());
    app.use(express.cookieParser());
    app.use(express.session({secret:"devoxx-2012" + env['DOTCLOUD_DATA_REDIS_PASSWORD']}));
    app.use(express.logger());
    app.use(express.methodOverride());

    app.use(app.router);
});


app.configure('development', function () {
    app.use(express.errorHandler({ dumpExceptions:true, showStack:true }));
});

app.configure('production', function () {
    app.use(express.errorHandler());
});





client = redis.createClient(env['DOTCLOUD_DATA_REDIS_PORT'], env['DOTCLOUD_DATA_REDIS_HOST']);

if (env['DOTCLOUD_DATA_REDIS_LOGIN']) {
    client.auth(env['DOTCLOUD_DATA_REDIS_PASSWORD'], env['DOTCLOUD_DATA_REDIS_LOGIN']);
}

app.use(express.bodyParser());
app.listen(process.env.PORT || 8080);

process.on('SIGTERM', function () {
    console.log('Got SIGTERM exiting...');
    // do some cleanup here
    process.exit(0);
});


client.on("error", function (err) {
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

//function removeVariableFromURL(url_string, variable_name) {
//    var URL = String(url_string);
//    var regex = new RegExp( "\\?" + variable_name + "=[^&]*&?", "gi");
//    URL = URL.replace(regex,'?');
//    regex = new RegExp( "\\&" + variable_name + "=[^&]*&?", "gi");
//    URL = URL.replace(regex,'&');
//    URL = URL.replace(/(\?|&)$/,'');
//    regex = null;
//    return URL;
//  }


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
                url:urlToFetch,
                cacheKey: cacheKey,
                forceNoCache: forceNoCache,
                clearCache: clearCache
            };
            processRequest(options);
        }
        else {
            client.get(cacheKey, function (err, data) {
                var options = {
                    req: req,
                    res: res,
                    cachedData: data,
                    err: err,
                    url:urlToFetch,
                    cacheKey: cacheKey,
                    forceNoCache: forceNoCache,
                    clearCache: clearCache
                };
                processRequest(options);
            });
        }
    } catch(err) { res.send(e.name + ": " + e.message, 500); }
});

function processRequest(options) {
    try {
        if (!options.forceNoCache && options.clearCache) {
            console.log("[" + options.url + "] Clearing cache for key: '" + options.cacheKey + "'");
             client.del(options.cacheKey);
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
                    options.res.send(data);
                }
                else {
                    var jsonData =  JSON.stringify(data);
                    console.log("[" + options.url + "] Fetched Response from url '" + targetUrl + "': " + jsonData);
                    sendJsonResponse(options, jsonData);
                    if (!options.forceNoCache) {
                        client.set(options.cacheKey, jsonData);
                        client.expire(options.cacheKey, 60 * 60);
                    }
                }
            });
        }
    } catch(err) {
        var errorMessage = e.name + ": " + e.message;
        console.log(errorMessage);
        options.res.send(errorMessage, 500);
    }
}
