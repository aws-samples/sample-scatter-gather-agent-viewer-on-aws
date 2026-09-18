import {
	BaseFootnoteDefinitionPlugin,
	BaseFootnoteReferencePlugin,
} from "@platejs/footnote";
import { MarkdownPlugin, remarkMdx, remarkMention } from "@platejs/markdown";
import { type AnySlatePlugin, KEYS } from "platejs";
import remarkEmoji from "remark-emoji";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

// Annotated because the inferred type references bun's isolated node_modules
// paths and fails declaration checks (TS2742).
export const MarkdownKit: AnySlatePlugin[] = [
	BaseFootnoteReferencePlugin,
	BaseFootnoteDefinitionPlugin,
	MarkdownPlugin.configure({
		options: {
			plainMarks: [KEYS.suggestion, KEYS.comment],
			remarkPlugins: [
				remarkMath,
				remarkGfm,
				remarkEmoji as any,
				remarkMdx,
				remarkMention,
			],
		},
	}),
];
