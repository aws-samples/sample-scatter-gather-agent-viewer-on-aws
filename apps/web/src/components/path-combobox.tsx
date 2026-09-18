import type { PathCheck } from "@repo/api/router";
import { CheckCircle2, Folder, Loader2, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@/components/ui/combobox";
import { client } from "@/orpc/client";

const FETCH_DEBOUNCE_MS = 200;

/** Everything up to the last "/" - the folder whose children we suggest. */
function parentOf(path: string): string {
	const trimmed = path.replace(/^\/+/, "");
	const slash = trimmed.lastIndexOf("/");
	return slash === -1 ? "" : trimmed.slice(0, slash);
}

function normalize(path: string): string {
	return path.trim().replace(/^\/+|\/+$/g, "");
}

/**
 * Path picker for the journey form: suggests the folders at the level being
 * typed (children of everything before the last "/") and, when the user
 * settles on a path - by selecting a suggestion or leaving the field -
 * confirms it actually holds objects.
 *
 * Selecting a folder fills it in with a trailing "/" so the user can keep
 * drilling; the existence check only runs on blur so it doesn't fire mid-way.
 * Typed paths that aren't suggested are fine: S3 has no real folders, so the
 * check is the source of truth.
 */
export function PathCombobox({
	id,
	name,
	bucketName,
	value,
	onChange,
	onBlur,
	invalid,
	placeholder = "source/app-code",
	allowEmpty = false,
}: {
	id: string;
	name: string;
	bucketName: string;
	value: string;
	onChange: (value: string) => void;
	onBlur?: () => void;
	invalid?: boolean;
	placeholder?: string;
	/** Optional fields (target) skip the check when left blank. */
	allowEmpty?: boolean;
}) {
	const [folders, setFolders] = useState<string[]>([]);
	const [loadingFolders, setLoadingFolders] = useState(false);
	const [check, setCheck] = useState<{
		path: string;
		result: PathCheck;
	} | null>(null);
	const [checking, setChecking] = useState(false);

	// Suggestions for the folder level currently being typed.
	const parent = parentOf(value);
	const latestFetch = useRef(0);
	useEffect(() => {
		const fetchId = ++latestFetch.current;
		setLoadingFolders(true);
		const timer = setTimeout(() => {
			client.journeys
				.listFolders({ bucketName, path: parent })
				.then((items) => {
					if (latestFetch.current === fetchId) setFolders(items);
				})
				.catch(() => {
					if (latestFetch.current === fetchId) setFolders([]);
				})
				.finally(() => {
					if (latestFetch.current === fetchId) setLoadingFolders(false);
				});
		}, FETCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [bucketName, parent]);

	const verify = async (raw: string) => {
		const path = normalize(raw);
		if (path === "") {
			setCheck(null);
			return;
		}
		if (check?.path === path) {
			return;
		}
		setChecking(true);
		try {
			const result = await client.journeys.checkPath({ bucketName, path });
			setCheck({ path, result });
		} catch {
			setCheck({
				path,
				result: { exists: false, error: "Could not check the path." },
			});
		} finally {
			setChecking(false);
		}
	};

	// Items carry a trailing "/" so that selecting one leaves the input ready
	// to drill into the next level. Base UI writes the selected item's string
	// into the input itself (after onValueChange), so the slash has to be part
	// of the item rather than appended by us.
	const items = useMemo(() => folders.map((folder) => `${folder}/`), [folders]);
	const status = check && check.path === normalize(value) ? check.result : null;

	return (
		<div className="flex flex-col gap-2">
			<Combobox
				items={items}
				defaultInputValue={value}
				onInputValueChange={(next) => onChange(next)}
				onValueChange={(selected) => {
					if (typeof selected === "string") {
						onChange(selected);
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
						if (allowEmpty && normalize(value) === "") {
							setCheck(null);
							return;
						}
						void verify(value);
					}}
				/>
				<ComboboxContent>
					<ComboboxEmpty>
						{loadingFolders ? (
							<span className="flex items-center justify-center gap-2">
								<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
								Loading folders…
							</span>
						) : (
							`No folders under ${parent === "" ? "the bucket root" : `"${parent}/"`}.`
						)}
					</ComboboxEmpty>
					<ComboboxList>
						{(item: string) => (
							<ComboboxItem key={item} value={item}>
								<Folder
									className="text-muted-foreground h-3.5 w-3.5 shrink-0"
									aria-hidden
								/>
								<span className="truncate font-mono text-xs">{item}</span>
							</ComboboxItem>
						)}
					</ComboboxList>
				</ComboboxContent>
			</Combobox>

			{checking ? (
				<p className="text-muted-foreground flex items-center gap-2 text-xs">
					<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
					Checking path…
				</p>
			) : status ? (
				status.exists ? (
					<p className="flex items-center gap-2 text-xs text-green-600 dark:text-green-500">
						<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
						Found objects under s3://{bucketName}/{normalize(value)}/
					</p>
				) : (
					<p className="text-destructive flex items-center gap-2 text-xs">
						<XCircle className="h-3.5 w-3.5" aria-hidden />
						{status.error ??
							`No objects found under s3://${bucketName}/${normalize(value)}/`}
					</p>
				)
			) : null}
		</div>
	);
}
