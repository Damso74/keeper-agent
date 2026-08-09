import { describe, expect, it } from "vitest";

import { extractJson } from "../src/keeperhub";

/**
 * `extractJson` doit survivre au format d'erreur réel de KeeperHub, y compris
 * depuis KeeperHub#1976 qui ajoute un diagnostic **après** le corps JSON.
 */
describe("extractJson", () => {
  it("lit un JSON pur", () => {
    expect(extractJson('{"wouldRevert":true}')).toEqual({ wouldRevert: true });
  });

  it("lit un JSON précédé d'un préfixe d'erreur", () => {
    const text = 'API call failed: 400 Bad Request - {"wouldRevert":true,"revertReason":"x"}';
    expect(extractJson(text)).toEqual({ wouldRevert: true, revertReason: "x" });
  });

  it("lit un JSON suivi d'un suffixe — le cas KeeperHub#1976", () => {
    // Avant le correctif, découper à la première accolade puis parser jusqu'à la
    // fin échouait ici, et tout le diagnostic était perdu.
    const text = [
      'API call failed: 400 Bad Request - {"wouldRevert":true,"from":"0xabc"}',
      "",
      "Simulation reverted. Nothing was signed or broadcast.",
      "Stage: simulation — this 400 describes the transaction, not your request.",
      "Reason: Error(ERC20: transfer amount exceeds balance)",
      "Next step:",
      "  - resolve the signer mode before acting on the reason.",
    ].join("\n");
    expect(extractJson(text)).toEqual({ wouldRevert: true, from: "0xabc" });
  });

  it("gère les objets imbriqués", () => {
    const text = 'prefix {"a":{"b":{"c":1}},"d":2} suffix';
    expect(extractJson(text)).toEqual({ a: { b: { c: 1 } }, d: 2 });
  });

  it("ignore les accolades situées dans une chaîne", () => {
    const text = 'err - {"reason":"unbalanced { brace","ok":true} trailing text';
    expect(extractJson(text)).toEqual({ reason: "unbalanced { brace", ok: true });
  });

  it("gère un guillemet échappé dans une chaîne", () => {
    const text = 'err - {"reason":"say \\"hi\\" }","ok":true} trailing';
    expect(extractJson(text)).toEqual({ reason: 'say "hi" }', ok: true });
  });

  it("renvoie null sur un message sans JSON", () => {
    expect(extractJson("Request failed with status 400")).toBeNull();
  });

  it("renvoie null sur une chaîne vide", () => {
    expect(extractJson("")).toBeNull();
  });

  it("renvoie null si l'objet ne se referme jamais", () => {
    expect(extractJson('prefix {"a":1')).toBeNull();
  });

  it("saute un premier objet invalide et retourne le suivant", () => {
    const text = 'note {not json} then {"real":true}';
    expect(extractJson(text)).toEqual({ real: true });
  });
});
