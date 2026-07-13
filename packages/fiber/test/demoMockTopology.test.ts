import assert from "node:assert/strict";
import { test } from "node:test";

import {
  connectMockNodes,
  createWorld,
  makeNode,
  seedCustomerHoldChannel,
} from "../../../scripts/demo/shared/mock-node.mjs";

const assetScript = {
  code_hash: "0x" + "22".repeat(32),
  hash_type: "type",
  args: "0xabcd",
};

test("mock topology seeds only the customer-funded channel to the hold node", () => {
  const world = createWorld();
  const hold = makeNode(world, "hold", 9227);
  const payment = makeNode(world, "payment", 9327);
  const merchant = makeNode(world, "merchant", 9247);
  const customer = makeNode(world, "customer", 9237);

  seedCustomerHoldChannel({ world, customerRole: "customer", holdRole: "hold", amount: 1000n, assetScript });

  assert.deepEqual(customer.rpc("list_peers", []).peers, [{ pubkey: hold.pubkey }]);
  assert.deepEqual(hold.rpc("list_peers", []).peers, [{ pubkey: customer.pubkey }]);
  assert.deepEqual(payment.rpc("list_peers", []).peers, []);
  assert.deepEqual(merchant.rpc("list_peers", []).peers, []);

  assert.equal(customer.channels.length, 1);
  assert.equal(customer.channels[0].pubkey, hold.pubkey);
  assert.equal(customer.channels[0].local_balance, "0x3e8");
  assert.equal(hold.channels[0].remote_balance, "0x3e8");
  assert.equal(payment.channels.length, 0);
  assert.equal(merchant.channels.length, 0);
});

test("mock connect_peer creates a peer session without creating a channel", () => {
  const world = createWorld();
  const payment = makeNode(world, "payment", 9327);
  const merchant = makeNode(world, "merchant", 9247);

  payment.rpc("connect_peer", [{ address: "/ip4/127.0.0.1/tcp/9247" }]);

  assert.deepEqual(payment.rpc("list_peers", []).peers, [{ pubkey: merchant.pubkey }]);
  assert.deepEqual(merchant.rpc("list_peers", []).peers, [{ pubkey: payment.pubkey }]);
  assert.equal(payment.channels.length, 0);
  assert.equal(merchant.channels.length, 0);
});

test("mock node_info exposes chain_hash and explicit connections can be composed", () => {
  const world = createWorld();
  const left = makeNode(world, "left", 9101);
  const right = makeNode(world, "right", 9102);
  connectMockNodes(world, "left", "right");

  assert.equal(left.rpc("node_info", []).chain_hash, "0xmock");
  assert.deepEqual(right.rpc("list_peers", []).peers, [{ pubkey: left.pubkey }]);
});

test("regular invoice payment requires a funded channel path", () => {
  const world = createWorld();
  const lsp = makeNode(world, "lsp", 9201);
  const merchant = makeNode(world, "merchant", 9202);
  const customer = makeNode(world, "customer", 9203);
  seedCustomerHoldChannel({ world, customerRole: "customer", holdRole: "lsp", amount: 1000n, assetScript });
  connectMockNodes(world, "lsp", "merchant");
  lsp.rpc("open_channel", [{
    pubkey: merchant.pubkey,
    funding_amount: "0x3e8",
    funding_udt_type_script: assetScript,
  }]);
  const issued = merchant.rpc("new_invoice", [{ amount: "0x64", currency: "Fibt", udt_type_script: assetScript }]);

  const paid = customer.rpc("send_payment", [{ invoice: issued.invoice_address }]);

  assert.equal(paid.status, "Success");
  assert.equal(customer.channels[0].local_balance, "0x384");
  assert.equal(lsp.channels.find((channel) => channel.pubkey === merchant.pubkey)?.local_balance, "0x384");
  assert.equal(merchant.channels[0].local_balance, "0x64");
});

test("regular invoice cannot jump between separated hold and payment nodes", () => {
  const world = createWorld();
  const hold = makeNode(world, "hold", 9301);
  const payment = makeNode(world, "payment", 9302);
  const merchant = makeNode(world, "merchant", 9303);
  const customer = makeNode(world, "customer", 9304);
  seedCustomerHoldChannel({ world, customerRole: "customer", holdRole: "hold", amount: 1000n, assetScript });
  connectMockNodes(world, "payment", "merchant");
  payment.rpc("open_channel", [{
    pubkey: merchant.pubkey,
    funding_amount: "0x3e8",
    funding_udt_type_script: assetScript,
  }]);
  const issued = merchant.rpc("new_invoice", [{ amount: "0x64", currency: "Fibt", udt_type_script: assetScript }]);

  assert.equal(customer.rpc("send_payment", [{ invoice: issued.invoice_address }]).status, "Failed");
});
