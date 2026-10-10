import test from "node:test";
import assert from "node:assert/strict";
import { balanceFromEvents, toCredits } from "../server/credits.mjs";

const at = (day) => new Date(`2026-01-${String(day).padStart(2, "0")}T00:00:00Z`);

test("credits are whole, customer-friendly units", () => {
  assert.equal(toCredits(0.8), 80);
  assert.equal(toCredits(0.066666), 7);
  assert.equal(toCredits(0), 0);
});

test("a later subscription cannot retroactively consume an older permanent top-up", () => {
  const r = balanceFromEvents([
    { at: at(1), type: "credit", amount: 10 },
    { at: at(2), type: "generation", amount: 5 },
    { at: at(3), type: "credit", amount: 15, expires_at: at(6) },
  ], +at(7));
  assert.equal(r.available, 5);
});

test("expiring monthly credits are consumed before permanent top-ups once both exist", () => {
  const r = balanceFromEvents([
    { at: at(1), type: "credit", amount: 15, expires_at: at(6) },
    { at: at(2), type: "credit", amount: 10 },
    { at: at(3), type: "agent", amount: 5 },
  ], +at(7));
  assert.equal(r.available, 10);
  assert.equal(r.agent, 5);
});

test("a failed generation returns its held credits", () => {
  const r = balanceFromEvents([
    { at: at(1), type: "credit", amount: 5 },
    { at: at(2), type: "generation", amount: 2 },
    { at: at(3), type: "generation", amount: -2 },
  ], +at(4));
  assert.equal(r.available, 5);
  assert.equal(r.generation, 0);
});

test("refunding a spent top-up creates debt instead of free credit", () => {
  const r = balanceFromEvents([
    { at: at(1), type: "credit", amount: 5 },
    { at: at(2), type: "generation", amount: 5 },
    { at: at(3), type: "credit", amount: -5 },
  ], +at(4));
  assert.equal(r.available, -5);
});
