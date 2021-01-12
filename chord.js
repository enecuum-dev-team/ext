let m = 4;

const argv = require('yargs').argv;
const jayson = require('jayson/promise');

require('console-stamp')(console, 'HH:MM:ss.l');

let rpc = function (node, func, args) {
	return new Promise(function(resolve, reject){

		//TODO: выяснить, откуда берётся undefined
		if ((node !== null) && (node !== undefined) ) {
			let client = jayson.client.http(node.ip);

			console.log('asking', node, 'for', func, 'with', args);

			client.request(func, args)
				.then(r => {
						resolve(r.result);
					}
				)
				.catch(e => {
					console.error('failed to connect');
					//reject();
					resolve(null);
				});
		} else {
			resolve(null);
		}
	});
};

class Node{

	/* checks if [a, id, b ] are placed clockwise*/
	static in_interval(node, a, b, half_closed = false){
		if (node === null)
			return false;
		let id = node.id;

		if ((a === undefined) || (a === null))
			return false;
		a = a.id;

		if ((b === undefined) || (b === null))
			return false;
		b = b.id;

		//console.log('in_interval', [id, a, b].join());
		if (id === null)
			return false;

		if (a === b)
			return true;

		if (a > b){
			if (id < b)
				id += Math.pow(2, m);
			b += Math.pow(2, m);
		}

		let r =  (a < id) && (((id < b) && !half_closed) || ((id <= b) && half_closed));
		return r;
	}

	static async find_successor(node){
		console.log('>', Node.id, '.find_successor', node);

		if (Node.in_interval(node, Node, Node.m_successor, true)){
			return Node.m_successor;
		} else {
			let n0 = await rpc(Node.m_successor, 'closest_preceding_node', node);
			console.log('n0 = ', n0);
			let r = await rpc(n0, 'find_successor', node);
			return r;
		}
	}

	static closest_preceding_node(node){
		console.log('>', Node.id, '.closest_preceding_node', node);

		for (let i = m - 1; i--; i >= 0){
			if (Node.in_interval(Node.fingers[i], Node, node)){
				console.log('result = ', Node.fingers[i]);
				return Node.fingers[i];
			}
		}

		return {id:Node.id, ip:Node.ip};
	}

	static create(){
		console.log('>', Node.id, '.create');
		Node.m_successor = {id:Node.id, ip:Node.ip};
		Node.m_predecessor = null;
	}

	static predecessor(){
		return Node.m_predecessor;
	}

	static async join(ip){
		console.log('>', Node.id, '.join', ip);

		let client = jayson.client.http(ip);

		Node.m_successor = await rpc({ip}, 'find_successor',{id:Node.id});
		console.log('succ = ', Node.m_successor);

	}

	static async stabilize(){
		console.log('>', Node.id, '.stabilize');

		let x = await rpc(Node.m_successor, 'predecessor', {});

		console.log('x = ', x );

		if (Node.in_interval(x, Node, Node.m_successor)){
			Node.m_successor = x;
		}
		rpc(Node.m_successor, 'notify', {id:Node.id, ip:Node.ip});
	}

	static notify(node){
		console.log('>', Node.id, '.notify', node);
		if ( (Node.m_predecessor == null) || (Node.in_interval(node, Node.m_predecessor, Node)) ){
			Node.m_predecessor = node;
		}
	}

	static async fix_fingers(){
		console.log('>', Node.id, '.fix_fingers');

		if (Node.finger_counter === undefined)
			Node.finger_counter = 0;
		else {
			console.log('fixing finger', Node.finger_counter, Node.fingers[Node.finger_counter]);
			let tmp = {id: (Node.id + Math.pow(2, Node.finger_counter)) % Math.pow(2, m)};
			Node.fingers[Node.finger_counter] = await Node.find_successor(tmp);

			let y = await rpc(Node.fingers[Node.finger_counter], 'ping', {});
			if (!y){
				Node.fingers[Node.finger_counter] = null;
			}

			Node.finger_counter = (Node.finger_counter + 1) % m;
		}
	}

	static async check_predecessor(){
		console.log('>', Node.id, '.check_predecessor');
		let x = await rpc(Node.m_predecessor, 'ping', {});

		if (x == null){
			Node.m_predecessor = null;
		}
	}

	static async check_successor(){
		console.log('>', Node.id, '.check_successor');
		let y = await rpc(Node.m_successor, 'ping', {});

		if (y == null){
			Node.m_successor = null;
		}

		if (Node.m_successor == null){
			for (let i = 0; i < m; i++){
				if (Node.fingers[i] != null){
					Node.m_successor = Node.fingers[i];
				}
			}
		}
	}

	static ping(){
		return "pong";
	}

	static state(){
		return [Node.m_predecessor, Node.m_successor, Node.fingers.join()];
	}

	constructor(id, peer){
		Node.m_successor = null;
		Node.m_predecessor = null;
		Node.id = id;
		Node.ip = "http://127.0.0.1:"+ (8000 + Node.id);
		Node.fingers = new Array(m).fill(null, 0, m);

		if (peer !== undefined){
			Node.join(peer);
		} else {
			Node.create();
		}

		console.log(Node);
	}
}

method_factory = function (acc, value) {

	acc[value] = function (args) {
		return new Promise(function (resolve) {
			console.log(value, 'is called', 'with', args);
			resolve(Node[value](args));
		})
	};

	return acc;
};

let obj = ['find_successor', 'ping', 'notify', 'predecessor', 'closest_preceding_node'].reduce(method_factory, {});
let rpc_server = jayson.server(obj);

if (argv.id != null){
	console.log("Starting server at ", argv.id);
	rpc_server.http().listen(8000 + argv.id);
} else {
	throw "id not specified";
}

if (argv.join != null){
	console.log('Joining existing ring at node ', argv.join);

	new Node(argv.id, argv.join);

} else {
	console.log('Creating new routing ring');
	new Node(argv.id);
}


setInterval(function () {
	console.info('---------------------------------------- tick -----------------------------------------');
	Node.stabilize();
	Node.check_predecessor();
	Node.fix_fingers();
	Node.check_successor();
	console.log('STATE = ', Node.state());
}, 5000);

