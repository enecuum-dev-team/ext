const ws = require('ws').Server;
const Pending = require('../Pending');
const enq = require('../Enq');
const Utils = require('../Utils');
const crypto = require('crypto');
const Transport = require('../Transport').Tip;

const POA_PROTOCOL_VERSION = 4;

// Default value to be set from config in PoAServer()
let ecc_mode = "short";

let create_message = function(mblock_data, config, height){
	let LPoSID = config.leader_id;
	let ecc = new Utils.ECC(ecc_mode);
	let m_hash,leader_sign;
	if(height >= config.FORKS.fork_block_002) {
		mblock_data.nonce = 1;
		m_hash = Utils.hash_mblock(mblock_data);
	} else {
		let result = Utils.leader_sign_000(LPoSID, config.ecc[ecc_mode].msk, mblock_data, ecc, config.ecc[ecc_mode]);
		m_hash = result.m_hash;
		leader_sign = result.leader_sign;
	}

	let leader_beacon = {
		"ver":POA_PROTOCOL_VERSION,
		"method":"on_leader_beacon",
		"data": {
			"leader_id": LPoSID,
			"m_hash": m_hash,
			"leader_sign": leader_sign,
			"mblock_data" : mblock_data
		}
	};
	return leader_beacon
};

class PoAServer {
	constructor(cfg, db) {
		this.cfg = cfg;
		ecc_mode = this.cfg.ecc.ecc_mode || "short";
		console.info(`Starting poa server at port ${cfg.poa_port}`);
		if (cfg.ip_api_key === undefined)
			console.warn(`IP-API key undefined`);
		this.db = db;
		this.server = new ws({port: cfg.poa_port});
		this.mblock_interval = cfg.mblock_interval | 5000;

		setInterval(this.heartbeat.bind(this), cfg.poa_hearbeat_interval_ms | 25000);

		this.server.on('connection', this.on_connection.bind(this));
		this.pending = new Pending(db);
		this.clients = [];
		this.create_message = create_message;

		this.karma_min = this.cfg.karma.min;
		this.karma_dec = this.cfg.karma.dec;
		this.karma_inc = this.cfg.karma.inc;
		this.karma_max = this.cfg.karma.max;
		this.transport = new Transport(cfg.id, 'PoAServer');
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
            let timeout = 10000;
            const timer = setTimeout(() => {
                reject(new Error(`Promise timed out after ${timeout} ms`));
            }, timeout);

			ws.send(data, err => {
				if (err) {
					reject(err);
				} else {
					resolve(err);
				}
			});
		});
	}

	create_probe(publisher, tx_required, height) {
		let random_hash = crypto.createHmac('sha256', (Math.random() * 1e10).toString()).digest('hex');
		let txs = this.pending.get_random_txs(tx_required || 1);
		let probe_data = {kblocks_hash: random_hash, txs, publisher};

		let msg = create_message(probe_data, this.cfg, height);

		//TODO: создавать зонд более тонко (несуществующий хеш кблока может вызвать подозрение, как и случайные транзакции)
        msg.data.leader_sign = undefined;
		return msg;
	}

	choice_client(token) {
		//let clients = this.clients.slice();
		let clients = this.clients.map(function(c) {
				return {token:c.token, stake:c.stake, key:c.key};
		});
		console.silly(`choice_client clienst count = ${clients.length}`);
		let sum = clients.reduce(function (sum, client) {
			if (client.token === token)
				return sum + client.stake;
			else
				return sum + 0;
		}, 0);
		let x = Math.random() * sum;
		let tmp_sum = 0;
		console.debug(`sum = ${sum}, x = ${x}`);
		for (let i = 0; i < clients.length; i++) {
			if (clients[i].token === token) {
				tmp_sum += clients[i].stake;
				if (tmp_sum > x) {
					return clients[i];
				}
			}
		}
		return clients[0];
	}

	choice_token(clients, owner_tokens) {
		let token_list = clients.reduce(function (acc, el) {
			let item = acc.find(acc_item => acc_item.token === el.token);
			if (item)
				item.count++;
			else
				acc.push({token: el.token, count: 1});
			return acc;
		}, []);
		console.debug(`token list ${JSON.stringify(token_list)}`);
		console.debug(`owner_tokens ${JSON.stringify(owner_tokens)}`);
		let active_ovner_tokens = token_list.filter(el => owner_tokens.some(item => item.hash === el.token ));
		console.debug(`active_ovner_tokens = ${active_ovner_tokens.length}`);
		//if exist miners
		if(active_ovner_tokens.length > 0)
			token_list = active_ovner_tokens;
		let sum = token_list.reduce(function (accumulator, currentValue) {
			return accumulator + currentValue.count;
		}, 0);
		console.debug({sum});
		let x = Math.random() * sum;
		let tmp_sum = 0;
		for (let item of token_list) {
			tmp_sum += item.count;
			if (tmp_sum >= x)
				return item.token;
		}
	}

	async send_mblock(mblock, owner, height) {
		let tries = 0;
		let sent = false;
		let sent_hash = null;

		if (this.clients.length === 0) {
			console.debug(`no connected clients`);
			return false;
		}

		do {
			let owner_tokens = [];
			console.debug(`select owner ${owner.substring(0,10)}`);
			if(owner != undefined)
				owner_tokens = await this.db.get_minable_tokens_by_owner(owner);
			let token = this.choice_token(this.clients, owner_tokens);
			console.debug({token});

			let time = process.hrtime();
			let client = this.choice_client(token);
			let choice_time = process.hrtime(time);

			console.silly('choice_time ', Utils.format_time(choice_time));
			let index = this.clients.findIndex(c => c.key === client.key);
			console.debug(`index : ${index}`);
			client = this.clients.splice(index, 1)[0];
			console.silly(`choice client stake = ${client.stake}`);
			if (client.ws.readyState === 1) {
				if (client.key !== undefined) {
					mblock.publisher = client.key;
					let beacon = create_message(mblock, this.cfg, height);
					let result = await this.use_client(client, beacon, height);
					console.trace(`result = ${JSON.stringify(result)}`);
					if (result.alive) {
						this.clients.push(client);
					}
					if (result.sent) {
						client.mblock = mblock;
						client.mblock.leader_sign = beacon.data.leader_sign;
						client.mblock_hash = beacon.data.m_hash;
						client.mblock_time = new Date();
						sent = true;
						sent_hash = beacon.data.m_hash;
					}
				} else {
					this.clients.push(client);
				}
			}
			tries++;
		} while (tries < this.clients.length && !sent);
		return {sent, sent_hash};
	}

	async use_client(client, beacon, height) {
		let sent = false;
		let alive = true;

		let now = new Date();
		if (client) {
			console.trace(`sending data to client ${client.id}@${client.ip}...`);
			let probe = null;

			let timeout = now - client.last_use;
			console.silly(`${client.id}@${client.ip} timeout = ${timeout}`);

			if (timeout < this.cfg.poa_min_interval_ms) {
				console.debug(`ignore client ${client.id} due to poa_min_interval_ms`);
			} else {
				let rnd = Math.random();
				console.trace(`${client.id}@${client.ip} karma = ${client.karma}, rnd = ${rnd}`);

				if ((client.karma < rnd) || ((client.last_use === null) && this.cfg.first_message_always_probe)) {
					console.trace(`Decision made to send a probe to ${client.id}@${client.ip}`);
					probe = this.create_probe(client.key, height);
				}

				if (client.key === undefined && this.cfg.first_message_always_probe) {
					client.karma /= this.karma_dec;
					console.warn(`${client.id}@${client.ip} still not introduced, launching probe and decreasing karma to ${client.karma}`);
					probe = this.create_probe(client.key, height);
				}

				if (client.karma < this.karma_min) {
					console.debug(`${client.id}@${client.ip} karma reduced to ${client.karma}, closing connection`);
					alive = false;
					//this.db.unregister_client(client);
					//this.db.update_clients(client.ip, -1, 2);
					client.ws.terminate();
				}

				if (client.ws.readyState !== 1) {
					console.debug(`${client.id}@${client.ip} client websocket closed`);
					alive = false;
				} else {
                    try {
                        if (probe) {
                            await this.send(client.ws, JSON.stringify(probe));
                        } else {
                            await this.send(client.ws, JSON.stringify(beacon));
                            sent = true;
                        }
                        client.last_use = now;
                    } catch (e) {
                        console.debug(`sending failed, ${e}`);
                        alive = false;
                    }
                }
			}
		}
		return {sent, alive};
	};

	async on_message(id, data) {
		let client = this.clients.find(x => x != null ? x.id === id : false);

		if (client === undefined)
			return;

		if (data.ver !== POA_PROTOCOL_VERSION) {
			console.warn(`${id} wrong protocol version`);
			//this.db.unregister_client(client);
			//this.db.update_clients(client.ip, -1, 2);
			this.send(client.ws, JSON.stringify({ver: POA_PROTOCOL_VERSION, err: "ERR_WRONG_PROTOCOL_VERSION"}));
			client.ws.terminate();
		}

		if (data.method === "publish") {
			if (client.key === undefined) {
				client.karma = 0;
				console.warn(`Client ${client.id}@${client.ip} tries to send microblock without inroduction, setting karma to ${client.karma}`);
			} else {
				console.trace(`got microblock ${data.data.m_hash} from ${client.id}@${client.ip}`);
				if (client.mblock_hash) {
					if (client.mblock_hash === data.data.m_hash) {
						if (Utils.ecdsa_verify(data.data.id, data.data.sign, data.data.m_hash + (data.data.hasOwnProperty('referrer') ? (data.data.referrer) : "") + data.data.token)) {
							client.karma += (this.karma_max - client.karma) * this.karma_inc;
							console.debug(`mblock ${data.data.m_hash} returned by ${client.id}@${client.ip} in ${new Date() - client.mblock_time}ms`);

							// Minable tokens: check token exist
							let token = await this.db.get_tokens_all(data.data.token);
							if (token[0]) {
								if (token[0].minable === 1) {
									client.mblock.sign = data.data.sign;
									client.mblock.hash = data.data.m_hash;
									client.mblock.referrer = data.data.referrer;
									client.mblock.token = data.data.token;
									//update user token and stake
									client.token = data.data.token;
									client.stake = await this.get_client_balance(client.key, client.token);
									let exist = await this.db.get_exist_microblocks(data.data.m_hash);
									if (exist.length === 0) {
										let accounts = await this.db.get_accounts_all([client.mblock.publisher]);
										let tokens = await this.db.get_tokens_all([client.mblock.token]);
										let valid_mblocks = Utils.valid_full_microblocks([client.mblock], accounts, tokens, true);
										if (valid_mblocks.length === 1) {
											await this.db.put_microblocks(valid_mblocks);
											if (client.token !== Utils.ENQ_TOKEN_NAME)
												this.transport.broadcast("microblocks", valid_mblocks);
										} else {
											client.karma = 0;
											console.warn(`Invalid block from ${client.id}@${client.ip} , mhash: ${data.data.m_hash}, setting karma to ${client.karma}.`);
										}
									} else {
										console.warn(`Wrong block from ${client.id}@${client.ip} , mhash: ${data.data.m_hash}, setting karma to ${client.karma}. Reason : block already exist`);
									}
								} else {
									client.karma = 0;
									console.warn(`Wrong block from ${client.id}@${client.ip} , mhash: ${data.data.m_hash}, setting karma to ${client.karma}. Reason : token ${data.data.token} not minable`);
								}
							} else {
								client.karma = 0;
								console.warn(`Wrong block from ${client.id}@${client.ip} , mhash: ${data.data.m_hash}, setting karma to ${client.karma}. Reason : token ${data.data.token} not found`);
							}
						} else {
							client.karma = 0;
							console.warn(`wrong signature from ${client.id}@${client.ip} for block ${data.data.m_hash}, setting karma to ${client.karma}`);
						}
					} else {
						client.karma /= this.karma_dec;
						console.warn(`wrong block from ${client.id}@${client.ip}: ${data.data.m_hash}, needed ${client.mblock_hash} lowering karma to ${client.karma}`);
					}
				} else {
					console.error(`Unexpected block from ${client.id}@${client.ip}!`);
					client.karma = 0;
				}
			}
		} else if (data.method === "hail") {
			console.debug(`client ${client.id}@${client.ip} introduced as ${data.data.id}`);
			let i = this.clients.findIndex(c => c.key === data.data.id);
			let client_old = this.clients[i];
			if (i !== -1) {
				console.warn(`duplicate key ${data.data.id} at old client ${client_old.id}@${client_old.ip}, disconnected`);
				if (client_old.ws.readyState === 1)
					this.send(client_old.ws, JSON.stringify({ver: POA_PROTOCOL_VERSION, err: "ERR_DUPLICATE_KEY"}));
				client_old.ws.terminate();
				console.debug(`clients_count = ${this.clients.length}`);
			}
			client.key = data.data.id;
			//TODO: request token from poa
			client.token = data.data.token || Utils.ENQ_TOKEN_NAME;
			client.stake = await this.get_client_balance(client.key, client.token);
			console.silly(`client ${client.id}@${client.ip} token: ${client.token} stake: ${client.stake}`);
			/*if (client.stake <= 0) {
				console.debug(`'hail' from client with low stake`);
				this.send(client.ws, JSON.stringify({ver: POA_PROTOCOL_VERSION, err: "ERR_WRONG_LOW_STAKE"}));
				client.ws.terminate();
				console.debug(`clients_count = ${this.clients.length}`);
			} else*/
				this.db.update_client({id, pubkey: client.key, type: 2});
		} else {
			console.warn(`${client.id}@${client.ip} unknown method - ${data.method}`);
		}
	}

	async get_client_balance(key, token){
		let balance = await this.db.get_balance(key, token);
		let stake = Number(BigInt(balance.amount) / BigInt(Math.pow(10, balance.decimals)));
		if (token === Utils.ENQ_TOKEN_NAME) {
		  if(stake > (this.cfg.stake_limits.max_stake / 1e10))
			stake = this.cfg.stake_limits.max_stake / 1e10;
		 if(stake < (this.cfg.stake_limits.min_stake / 1e10))
		 	stake = 0;
		}
		if (stake > 0)
			return 500 + stake / 5;
		else
			return 0;
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
			console.info(`client ${id} connected from ${ip}`);
			this.db.update_clients(ip, +1, 2);
			this.db.register_client({id, ip});
			this.clients.push({ws, id, ip, karma, last_use, key, token: Utils.ENQ_TOKEN_NAME, stake:0});
			console.debug(`clients_count = ${this.clients.length}`);
		} catch (e) {
			console.error(e);
			ws.terminate();
		}
		//this.update_iptable();

		ws.on('close', function () {
			console.info(`client ${id} disconnected 'on_close'`);
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

		}.bind(this));

		ws.on('pong', function () {
			console.debug(`pong`);
			this.isAlive = true;
		});
	};
}

module.exports.PoAServer = PoAServer;
module.exports.create_message = create_message;