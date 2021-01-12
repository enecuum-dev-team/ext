const Utils = require('../Utils');

class Indexer {
    constructor(config, db) {
        this.config = config;
        this.db = db;

        this.indexer();
    }

    async ledger_update(kblock, limit) {
        let hash = kblock.hash;
        let accounts = [];
        let refs = [];

        let time = process.hrtime();
        //console.debug(`indexer processing macroblock ${hash}`);
        console.trace(`indexer processing macroblock ${JSON.stringify(kblock)}`);

        let chunk = await this.db.get_not_indexed_microblocks(hash, limit);
        chunk.sblocks = await this.db.get_not_indexed_statblocks(hash, limit);

        console.silly('indexer chunk = ', JSON.stringify(chunk));
        console.debug(`indexer is processing chunk ${hash} of ${chunk.sblocks.length} sblocks and ${chunk.mblocks.length} mblocks with ${chunk.txs ? chunk.txs.length : "NaN"} txs`);

        if (chunk.mblocks.length === 0 && chunk.sblocks.length === 0) {
            console.debug(`No more blocks in kblock ${hash}, terminating`);
            await this.db.terminate_indexer_kblock(kblock);
            return;
        }

        if (chunk.sblocks.length > 0) {
            await this.db.process_indexer_sblocks(chunk.sblocks, kblock.time);
        }

        accounts.push(this.db.ORIGIN.publisher);

        accounts = accounts.concat(chunk.mblocks.map(m => m.publisher));
        accounts = accounts.concat(chunk.mblocks.map(m => m.referrer));
        if (chunk.txs === undefined) {
            console.info(`Txs in chunk is undefined`);
            return;
        }

        accounts = accounts.concat(chunk.txs.map(tx => tx.from));
        accounts = accounts.concat(chunk.txs.map(tx => tx.to));
        accounts = accounts.filter((v, i, a) => a.indexOf(v) === i);
        accounts = accounts.filter(v => v !== null);

        console.trace(`indexer ${accounts.length} accounts: ${JSON.stringify(accounts)}`);

        accounts = await this.db.get_accounts(accounts);

        console.silly(`accounts = ${JSON.stringify(accounts)}`);

        let duplicates = await this.db.get_indexed_duplicates(chunk.txs.map(tx => tx.hash));
        console.silly(`duplicates = ${JSON.stringify(duplicates)}`);
        console.debug(`duplicates.length = ${duplicates.length}`);

        let referrer_stake = await this.db.get_referrer_stake();
        if (referrer_stake.referrer_stake !== undefined) {
            referrer_stake = referrer_stake.referrer_stake;
        } else {
            console.warn(`referrer_stake not defined, assuming 0`);
            referrer_stake = 0;
        }
        chunk.mblocks.forEach((m) => {
            let pub = accounts.findIndex(a => a.id === m.publisher);
            let ref = accounts.findIndex(a => a.id === m.referrer);
            let org = accounts.findIndex(a => a.id === this.db.ORIGIN.publisher);
            if (pub > -1) {
                accounts[pub].amount += m.reward;
            } else {
                // If publisher not found we add it to accounts and get it's index
                pub = accounts.push({id: m.publisher, amount: m.reward}) - 1;
            }

            if (ref > -1) {
                if (accounts[ref].amount >= referrer_stake) {
                    refs.push({hash: m.hash, referral: accounts[pub].id, referrer: accounts[ref].id});
                } else {
                    refs.push({hash: m.hash, referral: accounts[pub].id, referrer: accounts[org].id});
                }
            } else {
                refs.push({hash: m.hash, referral: null, referrer: accounts[org].id});
            }
        });

        time = process.hrtime(time);
        console.debug(`chunk ${hash} prepared in`, Utils.format_time(time));

        time = process.hrtime();
        //await this.db.process_ledger_mblocks(accounts, statuses, chunk.mblocks, refs/*, kblock.time*/);
        await this.db.process_indexer_mblocks(chunk.txs, chunk.mblocks, refs, kblock.time);

        time = process.hrtime(time);
        console.debug(`chunk ${hash} saved in`, Utils.format_time(time));
    }

    async indexer() {
        try {
            let cur_hash = await this.db.get_indexer_pointer();
            if (cur_hash === null) {
                cur_hash = this.db.ORIGIN.hash;
            }
            console.silly("indexer current block = ", cur_hash);

            let next = await this.db.get_next_block(cur_hash);
            console.silly("indexer next_block = ", JSON.stringify(next));

            let cashier_ptr = await this.db.get_cashier_pointer();

            if (next && next.hash !== cashier_ptr && cur_hash !== cashier_ptr) {
                let block = (await this.db.get_kblock(cur_hash))[0];
                console.silly(`kblock time = ${JSON.stringify(block.time)}`);
                await this.ledger_update(block, this.config.indexer_chunk_size);
            } else {
                console.trace(`Indexer block ${cur_hash} not closed yet`)
            }
        } catch (e) {
            console.error(e);
        }
        setTimeout(this.indexer.bind(this), this.config.indexer_interval_ms);
    }
}

module.exports = Indexer;