const Utils = require('../Utils');
const Transport = require('../Transport').Tip;
var rx = require('../node_modules/node-randomx/addon');

class Miner {
	constructor(config, db) {
		this.db = db;
		this.config = config;
		this.difficulty = config.difficulty;
		this.count_not_complete = 0;
		//this.native_mblocks_count = this.config.mblock_slots.filter(s => s.token === Utils.ENQ_TOKEN_NAME)[0].count;
		this.native_mblocks_count = 1;
		this.sync_ranning = false;
		if (config.port === undefined) {
			console.warn(`Port is undefined - Miner is OFF`);
			return;
		}

		//TODO: reinit VM (change key), this fix etimeout starting DB
		this.start_pow_miner(config.randomx.key);

		//init transport
		this.transport = new Transport(this.config.id, 'miner');
		this.transport.on('wait_sync', this.on_wait_sync.bind(this));
		if (this.config.pos_share) {
			this.transport.on('emit_statblock', this.on_emit_statblock.bind(this));
			this.timer_resend_sblock = setTimeout(this.resend_sblock.bind(this), Utils.POS_RESEND_MINER_INTERVAL);
		} else {
			console.info(`PoS share not specified, PoS is OFF`)
		}
	}

	async init_vm_randomx(key) {
		console.info(`Starting RandomX virtual machine. mode - ${this.config.randomx.mode}`);
		try {
			this.vm = await rx.RandomxVM(key, ["jit", "ssse3", this.config.randomx.mode]);
			return 1;
		} catch (e) {
			console.error(e);
			return 0;
		}
	}

	async start_pow_miner(key) {
		if (this.config.load > 0) {
			let res = await this.init_vm_randomx(key);
			console.info(`Virtual mashine starting result: ${res}`);
			this.miner(this.config.load);
		} else {
			console.info(`POW Miner is OFF`);
		}
	}

	async resend_sblock() {
		try {
			let tail = await this.db.peek_tail();
			let kblocks_hash = tail.hash;
			console.debug(`re-broadcast sblock for kblock ${kblocks_hash}`);
			let sblocks = await this.db.get_statblocks(kblocks_hash);
			if(sblocks.length > 0)
				this.transport.broadcast("statblocks", sblocks);
			else {
				console.warn(`no found statblocks`);
				this.on_emit_statblock({data:kblocks_hash});
			}
		} catch (e) {
			console.error(e);
		}
		this.timer_resend_sblock = setTimeout(this.resend_sblock.bind(this), Utils.POS_RESEND_MINER_INTERVAL);
	}

	async on_emit_statblock(msg) {
		let kblocks_hash = msg.data;
		console.silly('on_emit_statblock kblocks_hash ', kblocks_hash);
		clearTimeout(this.timer_resend_sblock);

		let bulletin = "not_implemented_yet";
		let publisher = this.config.id;
		let sign = "";
		let sblock = {kblocks_hash, publisher, sign, bulletin};
		sblock.hash = Utils.hash_sblock(sblock).toString('hex');
		let time = process.hrtime();
		let result = await this.db.put_statblocks([sblock]);
		let put_time = process.hrtime(time);
		console.debug(`putting sblock time = ${Utils.format_time(put_time)} | result = ${result}`);
		if (result) {
			console.debug(`broadcast sblock for kblock ${kblocks_hash}`);
			this.transport.broadcast("statblocks", [sblock]);
		} else
			console.warn(`not insert sblock`);
		this.timer_resend_sblock = setTimeout(this.resend_sblock.bind(this), Utils.POS_RESEND_MINER_INTERVAL);
	}

	on_wait_sync(msg) {
		this.sync_ranning = msg.data;
	}

	async broadcast_cashed_macroblock(tail) {
		if (this.cached_macroblock === undefined) {
			let macroblock = await this.db.get_macroblock(tail.link);
			this.cached_macroblock = {candidate: tail, macroblock};
		}
		console.trace(`Resending macroblock ${JSON.stringify(this.cached_macroblock)}`);
		this.transport.broadcast("macroblock", this.cached_macroblock);
	};

	async miner(load) {
			console.silly(`Miner started with load ${load}`);
			try {
				if(this.sync_ranning) {
					console.debug(`Miner not started. Sync running...`);
					return;
				}
				let start = new Date();
				let tail = await this.db.peek_tail(this.config.tail_timeout);
				let cashier_ptr = await this.db.get_cashier_pointer();
				if(tail.hash !== cashier_ptr) {
					console.warn(`Cashier lags behind. Mining stopped`);
					return;
				}


				let mblocks = await this.db.get_microblocks_full(tail.hash);
				let sblocks = await this.db.get_statblocks(tail.hash);
				let snapshot_hash = undefined;
				let need_snapshot = false;
				//check snapshot
				if (tail.n % this.config.snapshot_interval === 0) {
					snapshot_hash = await this.db.get_snapshot_hash(tail.hash);
					if (snapshot_hash === undefined) {
						console.trace(`dosen\`t exist snapshot`);
						need_snapshot = true;
					}
				}
				console.trace(`mblocks ${mblocks.length}, sblocks ${sblocks.length}, snapshot ${need_snapshot}`);
				// Filter mblocks by min stakes
				let accounts = await this.db.get_accounts_all(mblocks.map(m => m.publisher));
				let tokens = await this.db.get_tokens_all(mblocks.map(m => m.token));
				mblocks = Utils.valid_full_microblocks(mblocks, accounts, tokens, false);
				// Filter sblocks by min stakes
				let pos_stakes = await this.db.get_pos_info(sblocks.map(s => s.publisher));
				let pos_min_stake = this.config.pos_min_stake;
				let top_poses = await this.db.get_top_poses(this.config.top_poses_count);
				sblocks = Utils.valid_full_statblocks(sblocks, pos_stakes, pos_min_stake, top_poses);
				// Check blocks
				if (mblocks.length > 0 && sblocks.length > 0 && !need_snapshot && Utils.exist_native_token_count(mblocks) >= this.native_mblocks_count) {
					this.count_not_complete = 0;
					let candidate = {
						time: Math.floor(new Date() / 1000),
						publisher: this.config.id,
						nonce: 0,
						link: tail.hash,
						m_root: Utils.merkle_root(mblocks, sblocks, snapshot_hash)
					};
					//calc difficulty target
					let db = this.db;
					let current_diff = await Utils.calc_difficulty(db, this.config.target_speed, tail);

					let now = new Date();
					let prev_calc = now - start;
					console.trace(`Previously calc time: ${prev_calc}`);
					start = now;

					let h;
					do {
						if (candidate.nonce % 5000 === 0) {
							now = new Date();
							let span = now - start;
							if (span / 10 >= load) {
								console.trace(`Miner not found hash in ${candidate.nonce} tries`);
								return;
							}
						}
						candidate.nonce++;
						h = Utils.hash_kblock(candidate, this.vm);
					} while (!Utils.difficulty_met(h, current_diff));

					candidate.hash = h.toString('hex');
					candidate.target_diff = current_diff;

					console.info(`Block ${candidate.hash} mined, ${candidate.link} terminated`);
					console.trace("Block mined ", JSON.stringify(candidate));
					let current_tail = await this.db.peek_tail();
					if (this.transport && tail.hash === current_tail.hash) {
						try {
							let time = process.hrtime();
							let result = await this.db.finalize_macroblock(candidate, mblocks, sblocks);
							let put_time = process.hrtime(time);
							if (!result) {
								console.warn('Block is not inserted');
							} else {
								console.debug(`macroblock ${candidate.hash} saved in `, Utils.format_time(put_time));
								//candidate.hash = undefined;
								//candidate.m_root = undefined;
								//TODO: здесь надо отправлять микроблоки без транзакций
								let macroblock = {kblock: tail};
								macroblock.mblocks = mblocks;
								macroblock.sblocks = sblocks;
								console.silly(`broadcasting macroblock ${JSON.stringify({candidate, macroblock})}`);
								this.cached_macroblock = {candidate, macroblock};
								this.transport.broadcast("macroblock", {candidate, macroblock});
							}
						} catch (e) {
							console.warn(`Failed to put candidate block (e) = ${e}`);
						}
					}
				} else {
					console.debug(`not a complete block ${tail.hash}, closing miner`);
					this.count_not_complete++;
					if (this.count_not_complete === Utils.MAX_COUNT_NOT_COMPLETE_BLOCK) {
						this.count_not_complete = 0;
						this.broadcast_cashed_macroblock(tail);
					}
				}
			} catch (e) {
				console.error(e);
			}
			finally {
				setTimeout(this.miner.bind(this), Utils.MINER_INTERVAL, load);
			}
	}
}

module.exports = Miner;