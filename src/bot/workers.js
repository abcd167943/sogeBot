const path = require('path');
const _ = require('lodash');
const {
  Worker, isMainThread, parentPort, threadId
} = require('worker_threads');

const __DEBUG__ =
  (process.env.DEBUG && process.env.DEBUG.includes('workers'))

class Workers {
  constructor() {
    this.path = path.join(__dirname, 'main.js')
    this.list = []
    this.onlineCount = 0
  }

  newWorker() {
    if (!isMainThread) {
      // although its possible to create thread in thread we don't want to
      return global.log.error('Cannot create new worker in thread');
    }
    if (global.mocha) {
      return global.log.error('Testing, not creating any workers');
    }

    const worker = new Worker(this.path)
    this.setListeners(worker)
    worker.on('exit', () => {
      if (__DEBUG__) { global.log.debug('Worker is dead'); }
      this.onlineCount--;
      this.newWorker();
    });
    worker.on('online', () => {
      if (__DEBUG__) { global.log.debug('Worker is online'); }
      this.onlineCount++;
    });
    this.list.push(worker);
  }

  sendToAll(opts) {
    if (isMainThread) {
      // run on master
      const namespace = _.get(global, opts.ns, null)
      namespace[opts.fnc].apply(namespace, opts.args)
      opts.type = 'call'
      this.sendToAllWorkers(opts);
    } else {
      // need to be sent to master
      this.sendToMaster(opts);
    }
  }

  send(opts) {
    if (!isMainThread) {
      this.sendToMaster(opts);
    } else {
      this.sendToWorker(opts);
    }
  }

  sendToMaster(opts) {
    if (isMainThread) {
      throw Error('Cannot send to master from master!');
    } else {
      parentPort.postMessage(opts)
    }
  }

  sendToAllWorkers(opts) {
    if (!isMainThread) {
      throw Error('Cannot send to worker from worker!');
    } else {
      for (const w of this.list) {
        w.postMessage(opts);
      }
    }
  }

  sendToWorker(opts) {
    if (!isMainThread) {
      throw Error('Cannot send to worker from worker!');
    } else {
      if (this.list.length === 0) {
        this.process(opts);
      } else {
        _.sample(this.list).postMessage(opts);
      }
    }
  }

  setListeners(worker) {
    if (isMainThread) {
      if (typeof worker === 'undefined' || worker === null) throw Error('Cannot create empty listeners in main thread!')
      this.setListenersMain(worker)
    } else {
      this.setListenersWorker()
    }
  }

  async process(data) {
    if (isMainThread) {
      // we need to be able to always handle db
      if (data.type === 'db') {
        // add data to master controller
        if (typeof global.db.engine.data !== 'undefined') {
          global.db.engine.data.push({
            id: data.id,
            items: data.items,
            timestamp: _.now()
          })
        }
        return;
      }

      if (!global.db.engine.connected || !(global.lib && global.lib.translate)) return setTimeout(() => this.process(data), 1000)
      if (__DEBUG__) { global.log.debug('MAIN: ' + JSON.stringify(data)); }

      if (data.type === 'lang') {
        for (let worker in cluster.workers) cluster.workers[worker].send({ type: 'lang' })
        await global.lib.translate._load()
      } else if (data.type === 'call') {
        const namespace = _.get(global, data.ns, null)
        namespace[data.fnc].apply(namespace, data.args)
      } else if (data.type === 'log') {
        return global.log[data.level](data.message, data.params)
      } else if (data.type === 'stats') {
        let avgTime = 0
        global.avgResponse.push(data.value)
        if (data.value > 1000) global.log.warning(`Took ${data.value}ms to process: ${data.message}`)
        if (global.avgResponse.length > 100) global.avgResponse.shift()
        for (let time of global.avgResponse) avgTime += parseInt(time, 10)
        global.status['RES'] = (avgTime / global.avgResponse.length).toFixed(0)
      } else if (data.type === 'say') {
        global.commons.message('say', null, data.message)
      } else if (data.type === 'me') {
        global.commons.message('me', null, data.message)
      } else if (data.type === 'whisper') {
        global.commons.message('whisper', data.sender, data.message)
      } else if (data.type === 'timeout') {
        global.commons.timeout(data.username, data.reason, data.timeout)
      } else if (data.type === 'api') {
        global.api[data.fnc](data.username, data.id)
      } else if (data.type === 'event') {
        global.events.fire(data.eventId, data.attributes)
      } else if ( data.type === 'interface') {
        _.set(global, data.path, data.value);
      }
    } else {
      if (__DEBUG__) { global.log.debug('THREAD(' + threadId + '): ' + JSON.stringify(data)); }
      switch (data.type) {
        case 'interface':
          _.set(global, data.path, data.value);
          break;
        case 'call':
          const namespace = _.get(global, data.ns, null)
          namespace[data.fnc].apply(namespace, data.args)
          break
        case 'lang':
          global.lib.translate._load()
          break
        case 'shutdown':
          gracefullyExit()
          break
        case 'message':
          global.tmi.message(data)
          break
        case 'db':
          switch (data.fnc) {
            case 'find':
              data.items = await global.db.engine.find(data.table, data.where, data.lookup)
              break
            case 'findOne':
              data.items = await global.db.engine.findOne(data.table, data.where, data.lookup)
              break
            case 'increment':
              data.items = await global.db.engine.increment(data.table, data.where, data.object)
              break
            case 'incrementOne':
              data.items = await global.db.engine.incrementOne(data.table, data.where, data.object)
              break
            case 'insert':
              data.items = await global.db.engine.insert(data.table, data.object)
              break
            case 'remove':
              data.items = await global.db.engine.remove(data.table, data.where)
              break
            case 'update':
              data.items = await global.db.engine.update(data.table, data.where, data.object)
              break
            case 'index':
              data.items = await global.db.engine.index(data.opts)
              break
            case 'count':
              data.items = await global.db.engine.count(data.table, data.where, data.object)
              break
            default:
              global.log.error('This db call is not correct')
              global.log.error(data)
          }

          global.workers.sendToMaster(data)
      }
    }
  }

  setListenersMain(worker) {
    if (__DEBUG__) { global.log.debug('MAIN: loading listeners'); }
    worker.on('message', (msg) => { this.process(msg) });
  }

  setListenersWorker() {
    if (__DEBUG__) { global.log.debug('THREAD(' + threadId + '): loading listeners'); }

    parentPort.on('message', (msg) => { this.process(msg) });
  }
}

module.exports = Workers