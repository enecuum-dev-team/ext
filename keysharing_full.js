var addon = require('../Enq');

let a = 	addon.BigNumber(1);
let b = 	addon.BigNumber(0);
let p = 	addon.BigNumber("80000000000000000000000000000000000200014000000000000000000000000000000000010000800000020000000000000000000000000000000000080003");
let order = addon.BigNumber("80000000000000000000000000000000000200014000000000000000000000000000000000010000800000020000000000000000000000000000000000080004");
let g0x = 	addon.BigNumber("2920f2e5b594160385863841d901a3c0a73ba4dca53a8df03dc61d31eb3afcb8c87feeaa3f8ff08f1cca6b5fec5d3f2a4976862cf3c83ebcc4b78ebe87b44177");
let g0y = 	addon.BigNumber("2c022abadb261d2e79cb693f59cdeeeb8a727086303285e5e629915e665f7aebcbf20b7632c824b56ed197f5642244f3721c41c9d2e2e4aca93e892538cd198a");
let q1 = 	addon.BigNumber("287a1a55f1c28b1c23a27eef69b6a537e5dfd068d43a34951ed645e049d6be0ac805e3c45501be831afe2d40a2395d8c72edb186c6d140bb85ae022a074b");

let strIrred = "2 1 1 6703903964971298549787012499102923063739684112761466562144343758833001675653841939454385015500446199477853424663597373826728056308768000892499915006541826";
let strA = "0 1";
let strB = "0 0";

let curve = addon.Curve(a, b, p, order, g0x, g0y);
let e_fq = addon.Curve_Fq(p.decString(), 2, strIrred, strA, strB);

//--------------------------------------------------------------------------------------

let parts = 5;
let sufficient = 3;

let msk = addon.BigNumber("63052130512cd908edf25d2abccb8dc0d40af1bee23a5d980afb3b9b012d");
let LPoSID = 14532;
let k_hash = '000063052130512cd908edf25d2abccb8dc0d40af1bee23a5d980afb3b9b012e';
let nonce = 5;
let PK_LPoS = addon.getHash(k_hash.toString() + LPoSID.toString() + (nonce).toString());
PK_LPoS = addon.BigNumber(PK_LPoS);
let Q = addon.getQ(PK_LPoS, curve, e_fq);
console.log("Q: " + Q.xy(curve));

// Participants of key sharing scheme
let ids = [
	addon.BigNumber("0320ddf18a7bedd6d61c5e3471cea5781e9fb2a1f334d57752cd2de46ec690c047"), 
	addon.BigNumber("033f11eebf74d91af1f332f96ad19ea3d386d602d1b773dc072a796004f1a71857"), 
	addon.BigNumber("0235c585f8da92ed22846977f81b999f36952759d7da8c94d8f8ec08d9654b0acd"), 
	addon.BigNumber("0312ceee0f51822db213f0b39f60f160ed689b9e8e35ba0ce60e22206757973bd2"), 
	addon.BigNumber("024f99a046245eebd0cdf25c5d54b0c6ca0bc7a384f2b97a185d2a4e48922ffe7c")
];

let shares = addon.shamir(msk, ids, parts, sufficient, order);

let coalition = [ 0, 3, 4 ];

let proj = [];
for(let i = 0; i < sufficient; i++)
	proj[i] = addon.mul(shares[coalition[i]], Q, curve);

console.log("Key shadows");
for (let i = 0; i < proj.length; i++){
	console.log(`ID: 	${ids[coalition[i]].hexString()}`);
	console.log(`share:  ${shares[coalition[i]].hexString()}`);
	console.log("shadow: ", proj[i].xy(curve));
}

let coal2 = [];
for(let i = 0; i < sufficient; i++)
	coal2[i] = ids[coalition[i]];

let secret = addon.keyRecovery(proj, coal2, q1, curve);
let check = addon.mul(msk, Q, curve);
console.log("Recovered secret SK:\t", secret.xy(curve));
console.log("Check secret MSK * Q:\t", check.xy(curve));