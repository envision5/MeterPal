import type {
	AgentConfig,
	BuyerAgentDefaults,
	SellerAgentMandate,
	SellerCoupon,
	SellerPackage,
} from "@autumn/shared";
import { Button, Input, Switch } from "@autumn/ui";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAgentConfigQuery } from "@/hooks/queries/useAgentConfigQuery";
import { getBackendErr } from "@/utils/genUtils";
import { SettingsSection } from "../SettingsSection";
import { SETTINGS_LIST_CLASS, SettingsGroup } from "../components/SettingsGroup";
import { SettingsListRow } from "../components/SettingsListRow";

const LADDER_GRID =
	"grid grid-cols-[minmax(90px,1.1fr)_minmax(120px,1.5fr)_80px_96px_84px_32px] items-center gap-2 px-3";

const num = (raw: string): number => {
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : 0;
};

const unitPrice = (p: SellerPackage): number =>
	p.credits > 0 ? p.list_price_usd / p.credits : 0;

/** A compact numeric cell that keeps the field editable while typing. */
const NumberInput = ({
	value,
	onChange,
	step = "1",
	className,
	suffix,
	invalid,
	title,
}: {
	value: number;
	onChange: (n: number) => void;
	step?: string;
	className?: string;
	suffix?: string;
	/** Marks the value as outside the merchant's own limits. */
	invalid?: boolean;
	title?: string;
}) => (
	<div className="relative">
		<Input
			type="number"
			inputMode="decimal"
			step={step}
			value={String(value)}
			title={title}
			onChange={(event) => onChange(num(event.target.value))}
			// `!` because `.input-base` sets `border` at the same specificity and
			// wins on source order; the built-in destructive variant only tints
			// on hover/focus, so it would not show while typing.
			className={`!bg-background h-8 text-sm ${suffix ? "pr-7" : ""} ${invalid ? "!border-destructive" : ""} ${className ?? ""}`}
		/>
		{suffix && (
			<span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-subtle text-xs">
				{suffix}
			</span>
		)}
	</div>
);

const TableHeader = ({ children }: { children: React.ReactNode }) => (
	<div className="flex items-center gap-2 px-3 pb-1 text-subtle text-xs">
		{children}
	</div>
);

export const AgentSection = () => {
	const { config, isLoading, update, isUpdating } = useAgentConfigQuery();
	const [draft, setDraft] = useState<AgentConfig | null>(null);

	useEffect(() => {
		if (config) setDraft(structuredClone(config));
	}, [config]);

	const isDirty = useMemo(() => {
		if (!draft || !config) return false;
		return JSON.stringify(draft) !== JSON.stringify(config);
	}, [draft, config]);

	// Coupons the agent can never actually activate.  The server accepts them
	// (a merchant may stage a coupon before raising the ceiling), so the page
	// has to say so plainly rather than relying on a red border.  Declared
	// above the loading return: hooks must run in the same order every render.
	const unusableCoupons = useMemo(() => {
		const seller = draft?.seller_agent_mandate;
		if (!seller) return [];
		const rungIds = new Set(seller.packages.map((p) => p.package_id));
		const problems: string[] = [];
		for (const coupon of seller.coupons) {
			if (coupon.discount_pct > seller.max_discount_pct) {
				problems.push(
					`'${coupon.coupon_id}' is ${coupon.discount_pct}% — above the ${seller.max_discount_pct}% ceiling`,
				);
			}
			const missing = (coupon.applies_to ?? []).filter((id) => !rungIds.has(id));
			if (missing.length > 0) {
				problems.push(
					`'${coupon.coupon_id}' applies to ${missing.join(", ")}, which is not on the ladder`,
				);
			}
		}
		return problems;
	}, [draft]);

	if (isLoading || !draft) {
		return (
			<SettingsSection title="Agent" description="Loading agent configuration…">
				<div className="h-40 animate-pulse rounded-lg bg-interactive-secondary" />
			</SettingsSection>
		);
	}

	const seller = draft.seller_agent_mandate;
	const buyer = draft.buyer_agent_defaults;

	const patchSeller = (next: Partial<SellerAgentMandate>) =>
		setDraft({ ...draft, seller_agent_mandate: { ...seller, ...next } });

	const patchBuyer = (next: Partial<BuyerAgentDefaults>) =>
		setDraft({ ...draft, buyer_agent_defaults: { ...buyer, ...next } });

	const setPackage = (index: number, next: Partial<SellerPackage>) => {
		const packages = seller.packages.map((p, i) =>
			i === index ? { ...p, ...next } : p,
		);
		patchSeller({ packages });
	};

	const addPackage = () => {
		const last = seller.packages[seller.packages.length - 1];
		patchSeller({
			packages: [
				...seller.packages,
				{
					package_id: `pack_${(last?.credits ?? 0) * 2 || 10}`,
					name: "New package",
					credits: (last?.credits ?? 5) * 2 || 10,
					list_price_usd: (last?.list_price_usd ?? 5) * 2 || 10,
				},
			],
		});
	};

	const removePackage = (index: number) =>
		patchSeller({ packages: seller.packages.filter((_, i) => i !== index) });

	const setCoupon = (index: number, next: Partial<SellerCoupon>) => {
		const coupons = seller.coupons.map((c, i) =>
			i === index ? { ...c, ...next } : c,
		);
		patchSeller({ coupons });
	};

	const addCoupon = () =>
		patchSeller({
			coupons: [
				...seller.coupons,
				{
					coupon_id: `coupon_${seller.coupons.length + 1}`,
					discount_pct: 5,
					applies_to: null,
					max_redemptions: null,
				},
			],
		});

	const removeCoupon = (index: number) =>
		patchSeller({ coupons: seller.coupons.filter((_, i) => i !== index) });

	const handleSave = async () => {
		try {
			await update({
				seller_agent_mandate: seller,
				buyer_agent_defaults: buyer,
			});
			toast.success("Agent configuration saved");
		} catch (error) {
			toast.error(getBackendErr(error, "Failed to save agent configuration"));
		}
	};

	return (
		<SettingsSection
			title="Agent"
			description="How the sales agent negotiates on your behalf, and the standing terms your customers' agents are offered."
			actions={
				<Button
					size="sm"
					onClick={handleSave}
					isLoading={isUpdating}
					disabled={!isDirty || isUpdating}
				>
					Save changes
				</Button>
			}
		>
			<SettingsGroup
				title="Sales agent"
				description="The agent that talks to your customers and drafts packages for your approval."
			>
				<div className={SETTINGS_LIST_CLASS}>
					<SettingsListRow
						title="Enabled"
						description="When off, customers get no negotiation and every package needs a manual price"
					>
						<Switch
							checked={seller.enabled}
							onCheckedChange={(enabled) => patchSeller({ enabled })}
						/>
					</SettingsListRow>
					<SettingsListRow
						title="Maximum discount"
						description="The largest coupon the agent may ever activate"
					>
						<NumberInput
							value={seller.max_discount_pct}
							onChange={(max_discount_pct) => patchSeller({ max_discount_pct })}
							suffix="%"
							className="w-24"
						/>
					</SettingsListRow>
					<SettingsListRow
						title="Price floor"
						description="No offer may price a credit below this, whatever the ladder says"
					>
						<NumberInput
							value={seller.min_unit_price_usd}
							onChange={(min_unit_price_usd) =>
								patchSeller({ min_unit_price_usd })
							}
							step="0.05"
							suffix="$"
							className="w-24"
						/>
					</SettingsListRow>
				</div>
			</SettingsGroup>

			<SettingsGroup
				title="Pricing ladder"
				description="The only packages the agent may quote. It picks a rung — it never sets a price."
				trailing={
					<Button variant="secondary" size="sm" onClick={addPackage}>
						<PlusIcon className="size-3.5" />
						Add package
					</Button>
				}
			>
				<div className="flex flex-col gap-1">
					<TableHeader>
						<div className={`${LADDER_GRID} w-full`}>
							<span>Package id</span>
							<span>Name</span>
							<span>Credits</span>
							<span>List price</span>
							<span>Per credit</span>
							<span />
						</div>
					</TableHeader>
					<div className="divide-y rounded-lg border bg-interactive-secondary">
						{seller.packages.map((pkg, index) => {
							const unit = unitPrice(pkg);
							const underFloor = unit < seller.min_unit_price_usd;
							return (
								<div key={`${pkg.package_id}-${index}`} className={LADDER_GRID}>
									<Input
										value={pkg.package_id}
										onChange={(event) =>
											setPackage(index, { package_id: event.target.value })
										}
										className="!bg-background h-8 font-mono text-xs"
									/>
									<Input
										value={pkg.name}
										onChange={(event) =>
											setPackage(index, { name: event.target.value })
										}
										className="!bg-background h-8 text-sm"
									/>
									<NumberInput
										value={pkg.credits}
										onChange={(credits) => setPackage(index, { credits })}
									/>
									<NumberInput
										value={pkg.list_price_usd}
										onChange={(list_price_usd) =>
											setPackage(index, { list_price_usd })
										}
										step="0.5"
									/>
									<span
										className={`text-xs ${underFloor ? "text-destructive" : "text-subtle"}`}
										title={
											underFloor
												? `Below the $${seller.min_unit_price_usd} floor`
												: undefined
										}
									>
										${unit.toFixed(2)}
									</span>
									<Button
										variant="skeleton"
										size="icon"
										disabled={seller.packages.length <= 1}
										onClick={() => removePackage(index)}
										aria-label={`Remove ${pkg.package_id}`}
										className="text-tertiary-foreground hover:text-destructive"
									>
										<Trash2Icon className="size-3.5" />
									</Button>
								</div>
							);
						})}
					</div>
				</div>
			</SettingsGroup>

			<SettingsGroup
				title="Authorized coupons"
				description="The only discounts the agent may activate. Anything not listed here it cannot offer at all."
				trailing={
					<Button variant="secondary" size="sm" onClick={addCoupon}>
						<PlusIcon className="size-3.5" />
						Add coupon
					</Button>
				}
			>
				<div className="flex flex-col gap-1">
					{seller.coupons.length === 0 ? (
						<div className="rounded-lg border bg-interactive-secondary px-4 py-6 text-center text-sm text-subtle">
							No coupons. The agent can only quote the ladder as published.
						</div>
					) : (
						<>
							<TableHeader>
								<div className="grid w-full grid-cols-[minmax(90px,1fr)_88px_minmax(120px,1.4fr)_104px_32px] items-center gap-2 px-3">
									<span>Coupon id</span>
									<span>Discount</span>
									<span>Applies to</span>
									<span>Max uses</span>
									<span />
								</div>
							</TableHeader>
							<div className="divide-y rounded-lg border bg-interactive-secondary">
								{seller.coupons.map((coupon, index) => {
									const overCeiling =
										coupon.discount_pct > seller.max_discount_pct;
									return (
										<div
											key={`${coupon.coupon_id}-${index}`}
											className="grid grid-cols-[minmax(90px,1fr)_88px_minmax(120px,1.4fr)_104px_32px] items-center gap-2 px-3"
										>
											<Input
												value={coupon.coupon_id}
												onChange={(event) =>
													setCoupon(index, { coupon_id: event.target.value })
												}
												className="!bg-background h-8 font-mono text-xs"
											/>
											<NumberInput
												value={coupon.discount_pct}
												onChange={(discount_pct) =>
													setCoupon(index, { discount_pct })
												}
												suffix="%"
												invalid={overCeiling}
												title={
													overCeiling
														? `Above the ${seller.max_discount_pct}% ceiling — the agent cannot activate this`
														: undefined
												}
											/>
											<Input
												value={coupon.applies_to?.join(", ") ?? ""}
												placeholder="All packages"
												onChange={(event) => {
													const raw = event.target.value.trim();
													setCoupon(index, {
														applies_to: raw
															? raw
																	.split(",")
																	.map((s) => s.trim())
																	.filter(Boolean)
															: null,
													});
												}}
												className="!bg-background h-8 text-xs"
											/>
											<Input
												type="number"
												placeholder="∞"
												value={coupon.max_redemptions ?? ""}
												onChange={(event) => {
													const raw = event.target.value.trim();
													setCoupon(index, {
														max_redemptions: raw ? num(raw) : null,
													});
												}}
												className="!bg-background h-8 text-sm"
											/>
											<Button
												variant="skeleton"
												size="icon"
												onClick={() => removeCoupon(index)}
												aria-label={`Remove ${coupon.coupon_id}`}
												className="text-tertiary-foreground hover:text-destructive"
											>
												<Trash2Icon className="size-3.5" />
											</Button>
										</div>
									);
								})}
							</div>
						</>
					)}
					{unusableCoupons.length > 0 && (
						<div className="mt-1 flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
							<span className="font-medium text-destructive text-xs">
								These coupons cannot be activated
							</span>
							{unusableCoupons.map((problem) => (
								<span key={problem} className="text-subtle text-xs">
									{problem}
								</span>
							))}
						</div>
					)}
				</div>
			</SettingsGroup>

			<SettingsGroup
				title="Buyer agent defaults"
				description="Standing terms your customers' own agents start from when they manage a wallet."
			>
				<div className={SETTINGS_LIST_CLASS}>
					<SettingsListRow
						title="Offer a buyer agent"
						description="Customers can let an agent top up their wallet without a per-purchase prompt"
					>
						<Switch
							checked={buyer.enabled}
							onCheckedChange={(enabled) => patchBuyer({ enabled })}
						/>
					</SettingsListRow>
					<SettingsListRow
						title="Per-purchase cap"
						description="The most a customer's agent may spend in one go"
					>
						<NumberInput
							value={buyer.max_per_purchase}
							onChange={(max_per_purchase) => patchBuyer({ max_per_purchase })}
							suffix="$"
							className="w-24"
						/>
					</SettingsListRow>
					<SettingsListRow
						title="Monthly budget"
						description="The agent stands down once this much has been spent this month"
					>
						<NumberInput
							value={buyer.monthly_budget}
							onChange={(monthly_budget) => patchBuyer({ monthly_budget })}
							suffix="$"
							className="w-24"
						/>
					</SettingsListRow>
					<SettingsListRow
						title="Auto-approve below"
						description="Purchases at or under this skip the in-app confirmation"
					>
						<NumberInput
							value={buyer.auto_approve_below}
							onChange={(auto_approve_below) =>
								patchBuyer({ auto_approve_below })
							}
							suffix="$"
							className="w-24"
						/>
					</SettingsListRow>
				</div>
			</SettingsGroup>
		</SettingsSection>
	);
};
