import { getLinkAttributes } from "@platejs/link";

import type { TLinkElement } from "platejs";
import type { SlateElementProps } from "platejs/static";
import { SlateElement } from "platejs/static";
import * as React from "react";
import { cn } from "@/lib/utils";

export function LinkElementStatic(props: SlateElementProps<TLinkElement>) {
	return (
		<SlateElement
			{...props}
			as="a"
			className={cn(
				// inlineSuggestionVariants() dropped: the suggestion plugin isn't
				// installed and read-only reports never render suggestion marks.
				"font-medium text-primary underline decoration-primary underline-offset-4",
			)}
			attributes={{
				...props.attributes,
				...getLinkAttributes(props.editor, props.element),
			}}
		>
			{props.children}
		</SlateElement>
	);
}
