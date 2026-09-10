import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./run-quality-mutations";
import { mutationFixture } from "./quality-mutation-fixture";
const { fixture, invoke, select, record, rows } = mutationFixture("operators");

const families = [
	{
		id: "boolean-literal",
		source: "export const run = () => true;",
		assert: "expect(run()).toBe(true);",
		outcome: "killed",
	},
	{
		id: "equality",
		source: "export const run = (a:number,b:number) => a === b;",
		assert: "expect(run(1,1)).toBe(true);",
		outcome: "killed",
	},
	{
		id: "relational",
		source: "export const run = (a:number,b:number) => a > b;",
		assert: "expect(run(2,1)).toBe(true);expect(run(1,1)).toBe(false);",
		outcome: "killed",
	},
	{
		id: "arithmetic",
		source: "export const run = (a:number,b:number) => a + b;",
		assert: "expect(run(2,1)).toBe(3);",
		outcome: "killed",
	},
	{
		id: "logical",
		source: "export const run = (a:boolean,b:boolean) => a && b;",
		assert: "expect(run(true,false)).toBe(false);",
		outcome: "killed",
	},
	{
		id: "bitwise",
		source: "export const run = (a:number,b:number) => a & b;",
		assert: "expect(run(2,1)).toBe(0);",
		outcome: "killed",
	},
	{
		id: "unary",
		source: "export const run = (a:boolean) => !a;",
		assert: "expect(run(true)).toBe(false);",
		outcome: "killed",
	},
	{
		id: "update",
		source: "export function run(n:number) {let x=n;return ++x;}",
		assert: "expect(run(2)).toBe(3);",
		outcome: "killed",
	},
	{
		id: "assignment",
		source: "export function run(x:number,n:number) {x+=n;return x;}",
		assert: "expect(run(3,2)).toBe(5);",
		outcome: "killed",
	},
	{
		id: "numeric-literal",
		source: "export const run = () => 42;",
		assert: "expect(run()).toBe(42);",
		outcome: "killed",
	},
	{
		id: "bigint-literal",
		source: "export const run = () => 42n;",
		assert: "expect(run()).toBe(42n);",
		outcome: "killed",
	},
	{
		id: "string-literal",
		source: 'export const run = () => "hello";',
		assert: 'expect(run()).toBe("hello");',
		outcome: "killed",
	},
	{
		id: "condition",
		source: "export function run(n:number){if(n)return 1;return 2;}",
		assert: "expect(run(1)).toBe(1);",
		outcome: "killed",
	},
	{
		id: "conditional-arm",
		source: "export const run = (n:number) => n ? 1 : 2;",
		assert: "expect(run(1)).toBe(1);",
		outcome: "killed",
	},
	{
		id: "statement-delete",
		source: "export function run(n:number){let x=0;x+=n;return x;}",
		assert: "expect(run(3)).toBe(3);",
		outcome: "killed",
	},
	{
		id: "return-value",
		source: "export function run():number|undefined{return 42;}",
		assert: "expect(run()).toBe(42);",
		outcome: "killed",
	},
	{
		id: "throw-delete",
		source: 'export function run(){throw new Error("boom");}',
		assert: "expect(run).toThrow();",
		outcome: "killed",
	},
	{
		id: "array-literal",
		source: "export const run = ():number[] => [1,2];",
		assert: "expect(run()).toEqual([1,2]);",
		outcome: "killed",
	},
	{
		id: "object-literal",
		source: "export const run = () => ({value:1});",
		assert: "expect(run()).toEqual({value:1});",
		outcome: "killed",
	},
	{
		id: "optional-chain",
		source: "export const run = (n:{value:number}) => n?.value;",
		assert: "expect(run({value:3})).toBe(3);",
		outcome: "survived",
	},
	{
		id: "await-delete",
		source:
			"export async function run(){const result=await Promise.resolve(3);return typeof result;}",
		assert: 'expect(await run()).toBe("number");',
		outcome: "killed",
	},
	{
		id: "switch-case",
		source:
			'export function run(n:number){switch(n){case 0:return "zero";default:return "other";}}',
		assert: 'expect(run(0)).toBe("zero");',
		outcome: "killed",
	},
	{
		id: "regex",
		source: "export const run = (s:string) => /^foo+$/.test(s);",
		assert:
			'expect(run("foo")).toBe(true);expect(run("fo")).toBe(false);expect(run("zfoo")).toBe(false);expect(run("fooz")).toBe(false);expect(run("FOO")).toBe(false);',
		outcome: "killed",
	},
	{
		id: "method",
		source: "export const run = (n:number[]) => n.filter(x=>x>0);",
		assert: "expect(run([-1,1])).toEqual([1]);",
		outcome: "killed",
	},
];
for (const family of families)
	test(`real operator seam: ${family.id}`, async () => {
		const input = await fixture(family.source, family.assert);
		const before = sha256(readFileSync(join(input.root, "src/a.ts")));
		const { report, selected, code } = await invoke(input, family.id, select(family.id));
		expect(code).toBe(family.outcome === "killed" ? 0 : 1);
		expect(report.full).toBe(false);
		expect(report.mutationZero).toBe(false);
		expect(report.complete).toBe(true);
		expect(report.cleanupVerified).toBe(true);
		expect(report.originalHashesVerified).toBe(true);
		expect(selected).toHaveLength(1);
		expect(selected[0]?.outcome).toBe(family.outcome);
		expect(selected[0]?.restored).toBe(true);
		if (family.outcome === "killed")
			expect(rows(selected[0]?.assertionIdentities).length).toBeGreaterThan(0);
		expect(sha256(readFileSync(join(input.root, "src/a.ts")))).toBe(before);
		for (const row of rows(report.census).map(record)) expect(rows(row.operators)).toHaveLength(24);
	}, 90000);


for (const source of [
	"let reads=0; const value={n:3,get method(){reads++;return function(this:{n:number}){return this.n;}}}; export const run=()=>[value?.method(),reads];",
	"let calls=0; const value={n:3,method(x:number){return this.n+x;}}; export const run=()=>[value?.method?.(++calls),calls];",
	"let keys=0; const value={n:3,method(){return this.n;}}; export const run=()=>[value?.[(++keys,'method')](),keys];",
])
	test("optional reference probe preserves single evaluation", async () => {
		const expected = source.includes("++calls") ? "[4,1]" : "[3,1]";
		const input = await fixture(source, `expect(run()).toEqual(${expected});`);
		const result = await invoke(input, "reference-effects", select("optional-chain"));
		expect(result.code).toBe(1);
		expect(result.selected[0]?.outcome).toBe("survived");
	}, 90000);

test("optional chain probe keeps skipped key and argument effects lazy", async () => {
	const input = await fixture(
		"let effects=0; const values:{method(x:number):number}[]=[]; const get=()=>values[0]!; export const run=():(number|undefined)[]=>[get()?.[(++effects,'method')](++effects),effects];",
		"expect(run()).toEqual([undefined,0]);",
	);
	const result = await invoke(input, "optional-lazy-effects", select("optional-chain"));
	// Removing ?. is itself a runtime error, but the ORIGINAL probe must be green.
	expect(result.code).toBe(2);
	expect(result.selected[0]?.reason).toBe("failure-without-complete-behavioral-assertions");
	const receipts = rows(result.selected[0]?.receipts).map(record);
	expect(receipts[1]?.exitCode).toBe(0);
}, 90000);

test("ordinary interpolated template has a runtime string mutant", async () => {
	const input = await fixture(
		`export const run=(s:string)=>\`hello \${s}\`;`,
		'expect(run("world")).toBe("hello world");',
	);
	const result = await invoke(input, "interpolated-string", select("string-literal"));
	expect(result.code).toBe(0);
	expect(result.selected[0]?.replacement).toBe('""');
}, 90000);

test("tagged template probe preserves tag receiver, raw data and substitutions", async () => {
	const input = await fixture(
		`let effects=0; const owner={n:3,tag(parts:TemplateStringsArray,x:number){return [this.n,parts.raw[0],x,effects];}}; export const run=()=>owner.tag\`hello\\n\${++effects}tail\`;`,
		'expect(run()).toEqual([3,"hello\\\\n",1,1]);',
	);
	const result = await invoke(input, "tagged-template", select("string-literal"));
	expect(result.code).toBe(0);
	expect(result.selected[0]?.outcome).toBe("killed");
	expect(rows(result.selected[0]?.receipts).map(record)[1]?.exitCode).toBe(0);
}, 90000);

