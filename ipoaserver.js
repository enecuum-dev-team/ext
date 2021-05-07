const crypto = require('crypto');
const argv = require('yargs').argv;
const fs = require('fs');

const Utils = require('../Utils');
const DB = require('../DB').DB;
const Leader = require(`.Leader`).Leader;

const CONFIG_FILENAME = 'config.json';

let config = {
    target_speed: 15,
    load: 0,
    peek_limit: 100,
    difficulty: 18,
    port: 8000,
    diff_target: 10, //sec
    dbhost: 'localhost',
    dbport: 3306,
    dbname: 'trinity',
    dbuser: 'root',
    dbpass: '',
    loglevel: 'info',
    explorer: 0,
    feeder_interval_ms: 100,
    cashier_interval_ms: 0,
    cashier_chunk_size: 2,
    indexer_interval_ms: 0,
    pending_size: 10,
    reward_ratio: {
        pos: 4000,
        poa: 4000,
        pow: 1600,
        ref: 400,
    },
    mode: 'verify',
    poa_hearbeat_interval_ms: 25000,
    poa_min_interval_ms: 10000,
    pending_timeout: 15,
    tail_timeout: 1000,
    max_tps: 70,
    max_mblocks_per_macroblock: 100,
    min_mblocks_per_macroblock: 5,
    max_txs_per_macroblock: 300,
    max_txs_per_microblock: 50,
    min_txs_per_microblock: 1,
    enable_rnd_txs: false,
    transport_on: 1,
    first_message_always_probe: true,
    karma: {
        init: 0.5,
        dec: 2,
        min: 0.1,
        inc: 0.2,
        max: 0.9
    },
    mblock_slots: [
        {
            token: Utils.ENQ_TOKEN_NAME,
            count: 2
        }
    ]
};

console.trace = function (...msg) {
    console.log(...msg);
};

console.debug = function (...msg) {
    console.log(...msg);
};

console.silly = function (...msg) {
    console.log(...msg);
};

console.fatal = function (...msg) {
    console.log(...msg);
    process.exit(1);
};

require('console-stamp')(console, {datePrefix: '[', pattern:'yyyy.mm.dd HH:MM:ss', level: 'info', extend:{fatal:0, debug:4, trace:5, silly:6}, include:['silly', 'trace','debug','info','warn','error','fatal']});

console.info("Application started");

let config_filename = argv.config || CONFIG_FILENAME;

console.info('Loading config from', config_filename, '...');

let cfg = {};
try {
    cfg = JSON.parse(fs.readFileSync(config_filename, 'utf8'));
    config = Object.assign(config, cfg);
} catch (e) {
    console.info('No configuration file found.')
}

config = Object.assign(config, argv);

console.info(`config = ${JSON.stringify(config)}`);

let db = new DB({
    host: config.dbhost,
    port: config.dbport,
    user: config.dbuser,
    database: config.dbname,
    password: config.dbpass.toString(),
    dateStrings: true,
    multipleStatements: true
}, config);


let start_leader = function(config, db) {
    BigInt.prototype.toJSON = function () {
        return this.toString()
    };

    let poa_server;
    if (config.poa_port !== undefined) {
        poa_server = new PoAServer(config, db);
    } else {
        console.info(`PoAServer is OFF`);
    }

    if (config.feeder_interval_ms) {
        console.info(`Starting feeder with interval ${config.feeder_interval_ms}`);
        feeder(poa_server);
    } else {
        console.info(`Feeder is OFF`);
    }
};
/*
let starter =  async function(config, db, callback) {
	if(!db.isConnected){
		setTimeout(starter, 1000, config, db, callback);
		return;
	}
	callback(config, db);
};

starter(config, db, start_leader);
*/
start_leader(config, db);