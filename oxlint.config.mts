import { defineConfig, type OxlintConfig } from "oxlint";

const error = "error";
const off = "off";
const warn = "warn";

const rules: NonNullable<OxlintConfig["rules"]> = {
	"no-var": error,
	"prefer-const": [warn, { destructuring: "all" }],
	"@typescript-eslint/consistent-type-imports": [
		error,
		{
			prefer: "type-imports",
			fixStyle: "separate-type-imports",
			disallowTypeAnnotations: false,
		},
	],
	"@typescript-eslint/no-import-type-side-effects": error,
	"@typescript-eslint/no-unused-vars": warn,
	"typescript/consistent-type-exports": error,
};

export default defineConfig({
	options: {
		typeAware: true,
	},
	plugins: ["typescript", "import", "node", "promise"],
	categories: {
		correctness: off,
		suspicious: off,
		pedantic: off,
		perf: off,
		style: off,
		restriction: off,
		nursery: off,
	},
	ignorePatterns: ["node_modules/", "dist/", "coverage/", "**/*.d.ts"],
	rules,
});
