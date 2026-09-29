/* Темная тема в tokens.css: два одинаковых блока темных значений и контраст текста в обеих темах.
   Запуск: npm test */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../src/ui/tokens.css", import.meta.url), "utf8");

function block(selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `нет блока ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const values = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) values.set(name, value.trim());
  return values;
}

const light = block(":root,\n.u-light");
const dark = new Map([...light, ...block(':root[data-theme="dark"]')]);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(tokens: Map<string, string>, text: string, back: string): number {
  const [a, b] = [tokens.get(text), tokens.get(back)].map((value) => {
    assert.match(value ?? "", /^#[0-9a-f]{6}$/i, `${text} или ${back} не цвет #rrggbb`);
    return luminance(value!);
  });
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("темные значения по выбору в настройках и как в системе одни и те же", () => {
  assert.deepEqual(block(":root:not([data-theme])"), block(':root[data-theme="dark"]'));
});

test("текст держит 4,5 к 1 на фоне страницы и на плитах в обеих темах", () => {
  const pairs: [string, string][] = [];
  for (const text of ["--ink", "--ink-soft", "--ink-faint", "--blue", "--stop", "--go", "--warn", "--signal-text"])
    for (const back of ["--paper", "--paper-cool", "--sheet"]) pairs.push([text, back]);
  pairs.push(
    ["--on-blue", "--blue"],
    ["--on-blue", "--blue-press"],
    ["--on-ink", "--ink"],
    ["--ink-deep", "--btn-light"],
    ["--blue", "--blue-tint"],
    ["--ink-soft", "--blue-tint"],
    ["--ink", "--blue-pale"],
    ["--ink", "--btn-light"],
    ["--on-deep", "--blue-deep"],
  );
  for (const [name, tokens] of [
    ["светлая", light],
    ["темная", dark],
  ] as const) {
    for (const [text, back] of pairs) {
      const ratio = contrast(tokens, text, back);
      assert.ok(ratio >= 4.5, `${name}: ${text} на ${back} ${ratio.toFixed(2)} к 1`);
    }
  }
});

test("в темной рамка поля держит 3 к 1 к фону, а текст не слепит белым", () => {
  for (const back of ["--paper", "--paper-cool", "--sheet"]) {
    const ratio = contrast(dark, "--edge-line", back);
    assert.ok(ratio >= 3, `--edge-line на ${back} ${ratio.toFixed(2)} к 1`);
  }
  // Основной текст на фоне страницы от 7 до 11 к 1: читается с запасом, но не белый по черному
  const ink = contrast(dark, "--ink", "--sheet");
  assert.ok(ink >= 7 && ink <= 11, `--ink на --sheet ${ink.toFixed(2)} к 1`);
});
