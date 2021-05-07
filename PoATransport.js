const ws = require('ws').Server;
const POA_PROTOCOL_VERSION = 4;

class PoATransport {
	constructor(cfg, db) {
		this.cfg = cfg;
		if (cfg.ip_api_key === undefined)
			console.warn(`IP-API key undefined`);
		this.db = db;
		this.server = new ws({port: cfg.poa_port});
		this.mblock_interval = cfg.mblock_interval | 5000;

		setInterval(this.heartbeat.bind(this), cfg.poa_hearbeat_interval_ms | 25000);

		this.server.on('connection', this.on_connection.bind(this));

		this.clients = [];
		this.create_message = create_message;

		this.karma_min = this.cfg.karma.min;
		this.karma_dec = this.cfg.karma.dec;
		this.karma_inc = this.cfg.karma.inc;
		this.karma_max = this.cfg.karma.max;
	}

	heartbeat() {
		this.server.clients.forEach(function each(ws) {
			if (ws.isAlive === false) {
				console.silly("He's dead, Jim.");
				return ws.terminate();
			}
			ws.isAlive = false;
			ws.ping(function () {
			});
		});
	}

	send(ws, data) {
		return new Promise((resolve, reject) => {
			ws.send(data, err => {
				if (err) {
					reject(err);
				} else {
					resolve(err);
				}
			});
		});
	}

	on_connection(ws, req) {
		let ip = req.socket.remoteAddress;
		if(!ip)
			return;
		ip = ip.substring(7);
		let karma = this.cfg.karma.init;
		let last_use = null;
		let key;
		let client_ids = this.clients.map(c => c.id);
		let id;
		do {
			id = Math.floor(Math.random() * (1e8 - 1e7) + 1e7);
		} while (client_ids.some(x => x === id));
		ws.id = id;
		ws.isAlive = true;
		try {
			console.trace(`client ${id} connected from ${ip}`);
			this.db.update_clients(ip, +1, 2);
			this.db.register_client({id, ip});
			this.clients.push({ws, id, ip, karma, last_use, key, token: Utils.ENQ_TOKEN_NAME, stake:0});
			console.debug(`clients_count = ${this.clients.length}`);
			emit('on_connect', {id, ip});
		} catch (e) {
			console.error(e);
			ws.terminate();
		}
		//this.update_iptable();

		ws.on('close', function () {
			console.trace(`client ${id} disconnected 'on_close'`);
			emit('on_disconnect', {id, ip});
			this.db.update_clients(ip, -1, 2);
			this.db.unregister_client({id});
			let i = this.clients.findIndex(c => c.id === id);
			if (i > -1)
				this.clients.splice(i, 1);
			else
				console.warn(`can not delete client ${id} - not found`);
			console.debug(`clients_count = ${this.clients.length}`);
		}.bind(this));

		ws.on('message', function (data) {
			console.trace('got message', JSON.stringify(data), 'from client', id);

			try {
				data = JSON.parse(data);
			} catch (e) {
				console.warn(`failed to parse ${id} client message `, data);
				return;
			}

			this.on_message(id, data);
			emit('on_message', {id,data});
		}.bind(this));

		ws.on('pong', function () {
			console.debug(`pong`);
			this.isAlive = true;
		});
	};
}

module.exports.PoATransport = PoATransport;
module.exports.create_message = create_message;