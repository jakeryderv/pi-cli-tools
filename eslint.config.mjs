import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
	{
		ignores: ["coverage/**", "node_modules/**"],
	},
	{
		files: ["**/*.{js,mjs,cjs}"],
		extends: [js.configs.recommended],
		languageOptions: {
			globals: globals.node,
		},
	},
	{
		files: ["**/*.ts"],
		extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
		languageOptions: {
			globals: globals.node,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
);
