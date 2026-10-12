/**
 * keys.test.ts — секреты: обратимое шифрование кошелька, корректная маска,
 * и — главное — /api/keys/status не содержит значений ключей.
 */
import "./_setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret, maskValue, getKeysStatus, setKeys } from "../keys.ts";

test("ключи: шифрование кошелька обратимо и не похоже на открытый текст", () => {
  const secret = "5Kd3N-test-seed-phrase-value-abcdef1234567890";
  const enc = encryptSecret(secret);
  assert.notEqual(enc, secret);
  assert.ok(!enc.includes(secret));
  assert.equal(decryptSecret(enc), secret);
});

test("ключи: маска — первые 4 и последние 2 символа", () => {
  assert.equal(maskValue("abcdef123456"), "abcd…56");
  assert.equal(maskValue("ab"), "a…b");
  assert.equal(maskValue(""), "");
});

test("ключи: status не отдаёт значения, у кошелька — публичный адрес", () => {
  const walletSecret = "SUPER-SECRET-WALLET-SEED-abcdef1234567890";
  const heliusKey = "helius-secret-key-000111222";
  setKeys({ wallet_secret: walletSecret, helius_api_key: heliusKey });

  const status = getKeysStatus();
  const asString = JSON.stringify(status);
  assert.ok(!asString.includes(walletSecret), "секрет кошелька не должен попасть в статус");
  assert.ok(!asString.includes(heliusKey), "значение ключа не должно попасть в статус");

  assert.equal(status.wallet.set, true);
  assert.ok(status.wallet.address.length > 20, "адрес кошелька должен быть непустым");
  assert.equal(status.wallet.preview, status.wallet.address, "у кошелька вместо маски — адрес");

  assert.equal(status.helius_api_key.set, true);
  assert.equal(status.helius_api_key.preview, "heli…22");
});
