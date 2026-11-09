'use strict';

// Test helper: answers Bonjour (mDNS) queries for _ipp._tcp like an HP printer does.
//   node test/fake-mdns-printer.js "HP DeskJet 2800e series [7A1B2C]" 127.0.0.1 8631 "HP DeskJet 2800e series"

const dgram = require('dgram');
const { encodeName } = require('../src/discovery');

const [instanceLabel = 'HP DeskJet 2800e series [7A1B2C]', ip = '127.0.0.1', port = '631', model = 'HP DeskJet 2800e series'] = process.argv.slice(2);
const host = 'HP7A1B2C.local';
const service = '_ipp._tcp.local';
const instance = `${instanceLabel}.${service}`;

function rr(name, type, data, cls = 0x8001) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(cls, 2);
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(name), head, data]);
}

function answer(id) {
  const ptr = rr(service, 12, encodeName(instance), 1);
  const srvHead = Buffer.alloc(6);
  srvHead.writeUInt16BE(0, 0);
  srvHead.writeUInt16BE(0, 2);
  srvHead.writeUInt16BE(Number(port), 4);
  const srv = rr(instance, 33, Buffer.concat([srvHead, encodeName(host)]));
  const txtParts = [`txtvers=1`, `ty=${model}`, `rp=ipp/print`, `usb_MFG=HP`, `UUID=7a1b2c00-0000-1000-8000-0000007a1b2c`].map((s) => {
    const b = Buffer.from(s);
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  const txt = rr(instance, 16, Buffer.concat(txtParts));
  const a = rr(host, 1, Buffer.from(ip.split('.').map(Number)));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6); // answers
  header.writeUInt16BE(3, 10); // additionals
  return Buffer.concat([header, ptr, srv, txt, a]);
}

function answerA(id) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  return Buffer.concat([header, rr(host, 1, Buffer.from(ip.split('.').map(Number)))]);
}

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sock.on('message', (msg, rinfo) => {
  if (msg.length < 12 || msg.readUInt16BE(2) & 0x8000) return; // ignore responses
  let reply;
  if (msg.includes(Buffer.from('_ipp'))) reply = answer(msg.readUInt16BE(0));
  else if (msg.toString('latin1').toLowerCase().includes(host.split('.')[0].toLowerCase())) reply = answerA(msg.readUInt16BE(0));
  else return;
  if (rinfo.port !== 5353) sock.send(reply, rinfo.port, rinfo.address); // legacy unicast
  else sock.send(reply, 5353, '224.0.0.251');
});
sock.bind(5353, () => {
  sock.addMembership('224.0.0.251');
  console.log(`fake mDNS printer "${instanceLabel}" -> ${ip}:${port}`);
});
