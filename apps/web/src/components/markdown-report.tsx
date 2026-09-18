import { createSlateEditor } from "platejs";
import { PlateStatic } from "platejs/static";
import { useMemo } from "react";
import { BaseBasicBlocksKit } from "@/components/editor/plugins/basic-blocks-base-kit";
import { BaseBasicMarksKit } from "@/components/editor/plugins/basic-marks-base-kit";
import { BaseCodeBlockKit } from "@/components/editor/plugins/code-block-base-kit";
import { BaseLinkKit } from "@/components/editor/plugins/link-base-kit";
import { BaseListKit } from "@/components/editor/plugins/list-base-kit";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { BaseTableKit } from "@/components/editor/plugins/table-base-kit";

/**
 * Read-only Markdown renderer built on Plate (platejs.org).
 *
 * Composes Plate's official base kits (installed from the Plate registry into
 * components/editor/plugins and components/ui/*-node-static) rather than
 * hand-rolled node components, and renders with PlateStatic - Plate's
 * lightweight non-interactive renderer. The Markdown string is deserialized
 * through @platejs/markdown (GFM enabled via MarkdownKit, for the tables the
 * aggregator loves). No dangerouslySetInnerHTML anywhere.
 */

const plugins = [
	...BaseBasicBlocksKit,
	...BaseBasicMarksKit,
	...BaseListKit,
	...BaseLinkKit,
	...BaseTableKit,
	...BaseCodeBlockKit,
	...MarkdownKit,
];

export function MarkdownReport({
	markdown,
	className,
}: {
	markdown: string;
	className?: string;
}) {
	const editor = useMemo(() => {
		const instance = createSlateEditor({ plugins });
		instance.children = instance.api.markdown.deserialize(markdown);
		return instance;
	}, [markdown]);

	return <PlateStatic editor={editor} className={className} />;
}
