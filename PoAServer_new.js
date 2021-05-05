const PoATransport= require('./PoATransport').PoATransport;
const Transport = require('../Transport').Tip;
const enq = require('../Enq');
const Utils = require('../Utils');
const crypto = require('crypto');
const Pending = require('../Pending');

// Default value to be set from config in PoATransport()
let ecc_mode = "short";

class PoAServer {
    constructor(config, db) {
        console.info(`Starting poa server at port ${config.poa_port}`);
        this.db = db;
        this.config = config;
        this.count_not_complete = 0;
        this.native_mblocks_count = 1;

        if (config.ip_api_key === undefined)
            console.warn(`IP-API key undefined`);
        ecc_mode = this.config.ecc.ecc_mode || "short";

        this.db.reset_poa_count();
        this.pending = new Pending(db);
        //init transport
        this.transport = new Transport(config.id, 'PoATransport');
        this.poa_transport = new PoATransport(config, db);
        this.feeder();
    };

    async feeder() {
        try {
            let k = await this.db.peek_tail(config.tail_timeout);
            let kblocks_hash = k.hash;
            let mblocks = await this.db.get_microblocks(kblocks_hash);

            let owner_slots = await this.init_slots(config.mblock_slots.count, kblocks_hash);
            console.info(`owner_slots = ${JSON.stringify(owner_slots)}`);
            let txs_awaiting = 0;
            if (mblocks.length !== 0)
                txs_awaiting = (await this.db.get_txs_awaiting(mblocks.map(m => m.hash))).txs_awaiting;
            let now = Math.floor(new Date() / 1000);
            if ((txs_awaiting >= config.max_txs_per_macroblock || mblocks.length >= config.max_mblocks_per_macroblock || now > (k.time + config.feader_watchdog)) && Utils.exist_native_token_count(mblocks) >= native_mblocks_count) {
                console.debug(`Transaction count exceeds config.max_txs_per_macroblock (${config.max_txs_per_macroblock})`);
                console.debug(`feader watchdog - ${now > (k.time + config.feader_watchdog)}`);
                let full_mblocks = await this.db.get_microblocks_full(kblocks_hash);
                console.debug(`broadcast microblocks count = ${full_mblocks.length}`);
                this.transport.broadcast("microblocks", full_mblocks);
            } else {
                let txs_required = config.max_tps * (config.feeder_interval_ms * 0.001);
                txs_required = Math.min(config.max_txs_per_microblock, Math.max(config.min_txs_per_microblock, txs_required));

                for (const slot of owner_slots) {
                    if (slot.count <= 0) {
                        continue;
                    }
                    if ((slot.id === undefined) && (mblocks.length >= config.max_mblocks_per_macroblock)) {
                        continue;
                    }
                    for (let i = 0; i < slot.count; i++) {
                        let txs = await pending.get_txs(txs_required, config.pending_timeout, config.enable_rnd_txs);
                        console.silly('txs = ', JSON.stringify(txs));
                        if (txs.length !== 0) {
                            let mblock_data = {kblocks_hash, txs};
                            let {sent, sent_hash} = await  this.poa_transport.send_mblock(mblock_data, slot.id);
                            if (sent) {
                                console.debug(`sent mblock ${sent_hash} for ${kblocks_hash} with txs [${txs.map(t => t.hash)}]`);
                            } else {
                                console.debug(`mblock NOT sent`);
                            }
                        }
                    }
                }
            }
        } catch
            (e) {
            console.error(e);
        }
        setTimeout(this.feeder, config.feeder_interval_ms);
    };

    async init_slots(size, kblock_hash) {
        let owner_slots = await this.db.get_mining_tkn_owners(size - config.mblock_slots.reserve.length, config.mblock_slots.reserve, config.mblock_slots.min_stake);
        owner_slots = owner_slots.concat(config.mblock_slots.reserve.map(function (item) {
            return {id: item};
        }));
        owner_slots.forEach(item => item.count = config.mblock_slots.size); //set slot size
        let used_slots = await this.db.get_used_slots(kblock_hash);
        used_slots.forEach(item => {
            let index = owner_slots.findIndex(e => e.id === item.id);
            if (index === -1)
                return;
            owner_slots[owner_slots.findIndex(e => e.id === item.id)].count = Number(owner_slots[owner_slots.findIndex(e => e.id === item.id)].count) - Number(item.count);
        });

        return owner_slots;
    };

    //-----------------------------------
    create_probe(publisher, tx_required) {
        let random_hash = crypto.createHmac('sha256', (Math.random() * 1e10).toString()).digest('hex');
        let txs = this.pending.get_random_txs(tx_required || 1);
        let probe_data = {kblocks_hash: random_hash, txs, publisher};

        let msg = this.create_message(probe_data, this.cfg);

        //TODO: создавать зонд более тонко (несуществующий хеш кблока может вызвать подозрение, как и случайные транзакции)
        //msg.data.mblock_data.txs[0].nonce++;
        //msg.data.mblock_data.k_hash = crypto.createHmac('sha256', (Math.random()*1e10).toString()).digest('hex');
        if (ecc_mode === "short") {
            msg.data.leader_sign.r.x++;

        } else {
            msg.data.leader_sign.r.x = ["123", '456'];

        }
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

    async send_mblock(mblock, owner) {
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
                    let beacon = create_message(mblock, this.cfg);
                    let result = await this.use_client(client, beacon);
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

    async use_client(client, beacon) {
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
                    probe = this.create_probe(client.key);
                }

                if (client.key === undefined && this.cfg.first_message_always_probe) {
                    client.karma /= this.karma_dec;
                    console.warn(`${client.id}@${client.ip} still not introduced, launching probe and decreasing karma to ${client.karma}`);
                    probe = this.create_probe(client.key);
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
                }

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
            let min_stake = 0;
            if (client.token === Utils.ENQ_TOKEN_NAME)
                min_stake = this.cfg.stake_limits.min_stake / 1e10;
            if (client.stake < min_stake) {
                console.debug(`'hail' from client with low stake`);
                this.send(client.ws, JSON.stringify({ver: POA_PROTOCOL_VERSION, err: "ERR_WRONG_LOW_STAKE"}));
                client.ws.terminate();
                console.debug(`clients_count = ${this.clients.length}`);
            } else
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

    create_message(mblock_data, config, need_fail){
        let LPoSID = config.leader_id;

        let msk = enq.BigNumber(config.ecc[ecc_mode].msk);
        let ecc = new Utils.ECC(ecc_mode);

        let H, Q, m_hash;
        let secret, leader_sign;
        let weil_err = false;
        let verified = true;

        mblock_data.nonce = 0;

        if(ecc_mode === "short"){
            do {
                mblock_data.nonce = mblock_data.nonce + 1;
                //mblock_data.txs[0].nonce = mblock_data.txs[0].nonce + 1;
                m_hash = Utils.hash_mblock(mblock_data);
                console.silly(`recreating block, nonce = ${mblock_data.nonce}, m_hash = ${m_hash}`);

                let PK_LPoS = enq.getHash(mblock_data.kblocks_hash.toString() + LPoSID.toString() + mblock_data.nonce.toString());
                let H_hash = enq.getHash(m_hash.toString() + LPoSID.toString());
                H = enq.toPoint(parseInt(H_hash.slice(0, 5), 16), ecc.G, ecc.curve);
                Q = enq.toPoint(parseInt(PK_LPoS.slice(0, 5), 16), ecc.G, ecc.curve);
                if (!H.isInfinity(ecc.curve) && !Q.isInfinity(ecc.curve)){
                    secret = enq.mul(msk, Q, ecc.curve);
                    leader_sign = enq.sign(m_hash, LPoSID, ecc.G, ecc.G0, secret, ecc.curve);
                    weil_err = ((parseInt(H_hash.slice(0, 5), 16) % 13) === 7) && (leader_sign.r.x === 41)  && (leader_sign.r.y === 164);
                }

            } while (need_fail ^ (H.isInfinity(ecc.curve) || Q.isInfinity(ecc.curve) || weil_err));

        }
        else{
            do {
                mblock_data.nonce = mblock_data.nonce + 1;
                //mblock_data.txs[0].nonce = mblock_data.txs[0].nonce + 1;
                m_hash = Utils.hash_mblock(mblock_data);
                console.silly(`recreating block, nonce = ${mblock_data.nonce}, m_hash = ${m_hash}`);
                let PK_LPoS = enq.getHash(mblock_data.kblocks_hash.toString() + LPoSID.toString() + mblock_data.nonce.toString());
                //Q = enq.toPoint(PK_LPoS, G, curve);
                let bnPK_LPoS = enq.BigNumber(PK_LPoS);
                let Q = enq.getQ(bnPK_LPoS, ecc.curve, ecc.e_fq);
                secret = enq.mul(msk, Q, ecc.curve);
                try{
                    leader_sign = enq.sign_tate(m_hash, LPoSID, ecc.G0_fq, secret, ecc.curve, ecc.e_fq);
                    //verified = enq.verify_tate(leader_sign, m_hash, PK_LPoS, G0_fq, MPK_fq, LPoSID, curve, e_fq);
                }
                catch(e){
                    console.error(e)
                }

            } while (need_fail ^ !verified);
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
}
