var sync = function () {
  var METAFILE = 'Violentmonkey';
  var services = [];
  var servicesReady = [];
  var queue = [];
  var syncing;
  var timer;
  var inited;

  function ServiceConfig(name) {
    this.prefix = name;
    this.load();
  }
  ServiceConfig.prototype.get = function (key, def) {
    var val = this.data[key];
    if (val == null) val = def;
    return val;
  };
  ServiceConfig.prototype.set = function (key, val) {
    if (typeof key === 'object') {
      if (arguments.length === 1) {
        _.assign(this.data, key);
        this.dump();
      }
    } else if (this.data[key] !== val) {
      this.data[key] = val;
      this.dump();
    }
  };
  ServiceConfig.prototype.clear = function () {
    this.data = {};
    this.dump();
  };
  ServiceConfig.prototype.capitalize = function (string) {
    return string[0].toUpperCase() + string.slice(1);
  };
  ServiceConfig.prototype.getOption = function (key, def) {
    key = this.capitalize(key);
    return _.options.get(this.prefix + key, def);
  };
  ServiceConfig.prototype.setOption = function (key, val) {
    key = this.capitalize(key);
    return _.options.set(this.prefix + key, val);
  };
  ServiceConfig.prototype.load = function () {
    this.data = _.options.get(this.prefix, {});
  };
  ServiceConfig.prototype.dump = function () {
    _.options.set(this.prefix, this.data);
  };

  function service(name, methods) {
    var service = _.assign({}, methods, {
      config: new ServiceConfig(name),
    });
    setTimeout(function () {
      services.push(service);
      inited && initService(service);
    });
    return service;
  }
  function start(service) {
    if (service) {
      service.config.getOption('enabled') && queue.push(service);
    } else if (!syncing && queue.length < servicesReady.length) {
      queue = servicesReady.filter(function (service) {
        return service.config.getOption('enabled');
      });
    }
    if (syncing) return;
    queue.length && debouncedSync();
  }
  function debouncedSync() {
    console.log('Ready to sync');
    timer && clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      console.log('Start to sync');
      sync();
    }, 10000);
  }
  function stopSync() {
    console.log('Sync ended');
    syncing = false;
  }
  function sync() {
    var service = queue.shift();
    if (!service) return stopSync();
    syncing = true;
    syncOne(service).then(sync, stopSync);
  }
  function initService(service) {
    service.on('init', function () {
      servicesReady.push(service);
      start(service);
    });
    service.init();
  }
  function init() {
    inited = true;
    services.forEach(initService);
  }
  function getFilename(uri) {
    return encodeURIComponent(uri) + '.user.js';
  }
  function syncOne(service) {
    if (!service.inst) return;
    return Promise.all([
      service.inst.list(),
      service.inst.get(METAFILE)
      .then(function (data) {
        return JSON.parse(data);
      }, function (res) {
        if (res.status === 404) {
          return {};
        }
        throw res;
      }),
      vmdb.getScriptsByIndex('position'),
    ]).then(function (res) {
      var remote = {
        data: res[0],
        meta: res[1],
      };
      var local = {
        data: res[2],
        meta: service.config.get('meta', {}),
      };
      var firstSync = !local.meta.timestamp;
      var outdated = !local.meta.timestamp || remote.meta.timestamp > local.meta.timestamp;
      console.log('First sync:', firstSync);
      console.log('Outdated:', outdated);
      var map = {};
      var getRemote = [];
      var putRemote = [];
      var delRemote = [];
      var delLocal = [];
      remote.data.forEach(function (item) {
        map[item.uri] = item;
      });
      local.data.forEach(function (item) {
        var remoteItem = map[item.uri];
        if (remoteItem) {
          if (firstSync || remoteItem.modified <= item.custom.modified) {
            // up to date
            delete map[item.uri];
          }
        } else if (firstSync || !outdated) {
          putRemote.push(item);
        } else {
          delLocal.push(item);
        }
        return map;
      });
      for (var uri in map) {
        var item = map[uri];
        if (firstSync || outdated) {
          getRemote.push(item);
        } else {
          delRemote.push(item);
        }
      }
      var promises = [].concat(
        getRemote.map(function (item) {
          console.log('Download script:', item.uri);
          return service.inst.get(getFilename(item.uri)).then(function (code) {
            return vmdb.parseScript({
              code: code,
              modified: item.modified,
            });
          });
        }),
        putRemote.map(function (item) {
          console.log('Upload script:', item.uri);
          return service.inst.put(getFilename(item.uri), item.code).then(function (data) {
            if (item.custom.modified !== data.modified) {
              item.custom.modified = data.modified;
              return vmdb.saveScript(item);
            }
          });
        }),
        delRemote.map(function (item) {
          console.log('Remove remote script:', item.uri);
          return service.inst.remove(getFilename(item.uri));
        }),
        delLocal.map(function (item) {
          console.log('Remove local script:', item.uri);
          return vmdb.removeScript(item.id);
        })
      );
      return Promise.all(promises).then(function () {
        var promises = [];
        var remoteChanged;
        if (!remote.meta.timestamp || putRemote.length || delRemote.length) {
          remoteChanged = true;
          remote.meta.timestamp = Date.now();
          promises.push(service.inst.put(METAFILE, JSON.stringify(remote.meta)));
        }
        if (!local.meta.timestamp || getRemote.length || delLocal.length || remoteChanged) {
          local.meta.timestamp = remote.meta.timestamp;
          service.config.set('meta', local.meta);
        }
        return Promise.all(promises);
      });
    }).catch(err => console.log(err));
  }

  return {
    init: init,
    start: start,
    service: service,
  };
}();