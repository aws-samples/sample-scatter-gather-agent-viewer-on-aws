import type { BucketSummary } from "@repo/api/router";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@/components/ui/combobox";
import { client } from "@/orpc/client";

const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * Bucket picker for the journey form: lists the account's buckets in this
 * region as suggestions while still accepting a typed name (a bucket may be
 * missing from the list, or the listing itself may be denied).
 *
 * `onCommit` fires when the user settles on a name - by selecting a
 * suggestion or by leaving the field - so the caller can run the readiness
 * check without a separate "Check bucket" click. It only fires for
 * syntactically valid names, and not when the name hasn't changed.
 */
export function BucketCombobox({
	id,
	name,
	value,
	onChange,
	onBlur,
	onCommit,
	invalid,
	placeholder = "my-migration-bucket",
}: {
	id: string;
	name: string;
	value: string;
	onChange: (value: string) => void;
	onBlur?: () => void;
	onCommit: (bucketName: string) => void;
	invalid?: boolean;
	placeholder?: string;
}) {
	const [buckets, setBuckets] = useState<BucketSummary[] | null>(null);
	const [listError, setListError] = useState(false);
	const [lastCommitted, setLastCommitted] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		client.journeys
			.listBuckets({})
			.then((items) => {
				if (!cancelled) setBuckets(items);
			})
			.catch(() => {
				if (!cancelled) {
					setBuckets([]);
					setListError(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const commit = (raw: string) => {
		const trimmed = raw.trim();
		if (trimmed === "" || trimmed === lastCommitted) {
			return;
		}
		if (!BUCKET_NAME_PATTERN.test(trimmed)) {
			return;
		}
		setLastCommitted(trimmed);
		onCommit(trimmed);
	};

	const items = useMemo(
		() => buckets?.map((bucket) => bucket.name) ?? [],
		[buckets],
	);
	const loading = buckets === null;

	return (
		<Combobox
			items={items}
			// Free-text: the field's value is whatever is typed; selecting an item
			// just fills the input in. Base UI keeps the input state (controlling
			// `value` with no matching item clears it on every keystroke), and we
			// mirror the text out to the form.
			defaultInputValue={value}
			onInputValueChange={(next) => onChange(next)}
			onValueChange={(selected) => {
				if (typeof selected === "string") {
					onChange(selected);
					commit(selected);
				}
			}}
			autoHighlight
		>
			<ComboboxInput
				id={id}
				name={name}
				placeholder={placeholder}
				aria-invalid={invalid}
				autoComplete="off"
				spellCheck={false}
				onBlur={() => {
					onBlur?.();
					commit(value);
				}}
			/>
			<ComboboxContent>
				<ComboboxEmpty>
					{loading ? (
						<span className="flex items-center justify-center gap-2">
							<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
							Loading buckets…
						</span>
					) : listError ? (
						"Couldn't list buckets. Type the name instead."
					) : items.length === 0 ? (
						"No buckets in this region. Type a name to check it."
					) : (
						"No matching bucket. Press Tab to check the typed name."
					)}
				</ComboboxEmpty>
				<ComboboxList>
					{(item: string) => (
						<ComboboxItem key={item} value={item}>
							<span className="truncate font-mono text-xs">{item}</span>
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}
