const argv = require('yargs').argv;
const fs = require('fs');
const Utils = require('../Utils');
const DB = require('../DB').DB;

const CONFIG_FILENAME = 'config.json';

let config = {
    dbhost : 'localhost',
    dbname : 'trinity',
    dbuser : 'root',
    dbpass : '',
    loglevel : 'info',
    snapshot_path : 'gen_snapshot.json'
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

console.info("Generator started");

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

require('console-stamp')(console, {datePrefix: '[', pattern:'yyyy.mm.dd HH:MM:ss', level: config.loglevel, extend:{fatal:0, debug:4, trace:5, silly:6}, include:['silly', 'trace','debug','info','warn','error','fatal']});

let db = new DB({
    host: config.dbhost,
    port: config.dbport,
    user: config.dbuser,
    database: config.dbname,
    password: config.dbpass.toString(),
    dateStrings: true,
    multipleStatements: true,
    useNativeBigInt : false
},config);
//BigInt.prototype.toJSON = function() { return this.toString() };

let generate = async function(config, db) {
    let height = (await db.get_mblocks_height()).height;
    console.info({height});
    let snapshot_header = await db.get_snapshot_before(height);
    console.info(`snapshot header - ${JSON.stringify(snapshot_header)}`);

    let snapshot = await db.get_snapshot(snapshot_header.hash);

    let kblock = (await db.get_kblock(snapshot_header.kblocks_hash))[0];
    kblock.link = kblock.hash;
    kblock.n = 0;
    delete kblock.leader_sign;
    delete kblock.reward;
    delete kblock.target_diff;
    let data =  JSON.parse(snapshot.data);
    data.kblock = kblock;
    data.farms.forEach(farm =>{
        farm.last_block -= snapshot_header.n;
    });

    data.undelegates.forEach(und => {
        und.height -= snapshot_header.n;
    });

    try {
        fs.writeFileSync(config.snapshot_path, JSON.stringify(data))
    } catch (err) {
        console.error(err);
    }
    console.info('done');
    process.exit(1);
};


generate(config, db);