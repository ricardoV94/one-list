import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('    function calculatorExpression(');
const end = html.indexOf('    function renderCalculator(', start);
const { expression, display } = new Function(html.slice(start, end) +
  '; return { expression: calculatorExpression, display: calculatorDisplay };')();
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok   ' + name); };
const vars = new Map();
const calc = source => expression(source, vars);
test('precedence, grouping, unary signs', () => {
  assert.equal(calc('2 + 3 * 4').value, 14);
  assert.equal(calc('-(2 + 3) * -4').value, 20);
  assert.equal(calc('24 / 3 / 2').value, 4);
  assert.equal(calc('10 - 3 - 2').value, 5);
});
test('named quantities and plain-number output', () => {
  vars.set('revenue', calc('25.00'));
  vars.set('cost', calc('17.50'));
  vars.set('profit', calc('revenue - cost'));
  assert.equal(display(calc('profit')), '7.50');
  assert.equal(display(calc('profit / revenue * 100')), '30.00');
  assert.equal(display(calc('25.00')), '25.00');
});
test('precision propagates through variables without rounding intermediates', () => {
  vars.set('third', calc('1.00 / 3'));
  assert.equal(display(calc('third * 3')), '1.00');
  assert.equal(display(calc('2000.0 / 3')), '666.7');
  assert.equal(display(calc('2000.00 / 3')), '666.67');
  assert.equal(display(calc('1 / 3')), '0.33');
  assert.equal(display(calc('1.0 + 0.125')), '1.125');
});
test('invalid input and JavaScript are rejected', () => {
  for (const source of ['', 'x', 'constructor', '1 / 0', '(2 + 3', '2 3',
    '1 +', '2 ** 3', '1,000', '1e3', 'alert(1)', 'globalThis.x = 1',
    '1; 2', '1k', '1 as k', '1%', '1 as %', '1 as usd', '10%%', '1.123456789012345678901']) {
    assert.throws(() => calc(source), undefined, source);
  }
});
test('unbounded inputs fail cleanly', () => {
  assert.throws(() => calc('9'.repeat(400)), /too large/);
  assert.throws(() => calc('('.repeat(300) + '1' + ')'.repeat(300)), /too long/);
});
console.log(`${passed} passed, 0 failed`);
