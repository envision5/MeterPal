import { invitation, member, user as userTable } from "@autumn/shared";
import type { Session } from "better-auth";
import type { Organization } from "better-auth/plugins/organization";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db/initDrizzle.js";
import { auth } from "@/utils/auth.js";
import { slugify } from "@/utils/genUtils.js";

export const createDefaultOrg = async ({
	session,
}: {
	session: Session;
}): Promise<Organization | undefined> => {
	try {
		const user = await db.query.user.findFirst({
			where: eq(userTable.id, session.userId),
		});

		const invites = await db
			.select()
			.from(invitation)
			.where(
				and(
					eq(invitation.email, user?.email || ""),
					eq(invitation.status, "pending"),
					gt(invitation.expiresAt, new Date()),
				),
			);

		if (invites.length > 0) {
			console.log(
				`Accepting invite for user ${session.userId} to org ${invites[0].organizationId}`,
			);

			await auth.api.addMember({
				body: {
					userId: session.userId,
					role: invites[0].role as any,
					organizationId: invites[0].organizationId,
				},
			});

			await db
				.update(invitation)
				.set({ status: "accepted" })
				.where(eq(invitation.id, invites[0].id));

			console.log(
				`Invite ${invites[0].id} accepted for user ${session.userId}`,
			);

			return invites[0].organizationId as any;
		}

		// First-run claim. `demo/bootstrap.py --admin you@example.com` seeds an
		// org and names it here, so the person who set it up signs in and lands
		// in *that* org instead of being handed an empty one of their own --
		// otherwise the dashboard and the demo app describe different
		// merchants, and every screen looks broken for the wrong reason.
		//
		// Who may claim:
		//   - with METERPAL_FIRST_RUN_EMAIL set, only that address. The email is
		//     the gate, so a second `bootstrap.py --admin` re-run still lands
		//     you in the same org rather than stranding you in a new one.
		//   - with only an org set, the first person to arrive, and the window
		//     closes as soon as anyone is a member.
		// Either way the branch never runs when METERPAL_FIRST_RUN_ORG is unset,
		// which is always the case in production.
		const claimOrgId = process.env.METERPAL_FIRST_RUN_ORG?.trim();
		const claimEmail = process.env.METERPAL_FIRST_RUN_EMAIL?.trim().toLowerCase();

		if (claimOrgId) {
			try {
				const mine = await db.query.member.findFirst({
					where: and(
						eq(member.organizationId, claimOrgId),
						eq(member.userId, session.userId),
					),
				});
				const anyone = claimEmail
					? null
					: await db.query.member.findFirst({
							where: eq(member.organizationId, claimOrgId),
						});
				const eligible = claimEmail
					? claimEmail === (user?.email ?? "").trim().toLowerCase()
					: !anyone;

				if (!mine && eligible) {
					await auth.api.addMember({
						body: {
							userId: session.userId,
							role: "owner" as any,
							organizationId: claimOrgId,
						},
					});
					console.log(
						`[first-run] ${user?.email ?? session.userId} claimed org ${claimOrgId} as owner`,
					);
					return claimOrgId as any;
				}
			} catch (error) {
				// Fall through to the normal path rather than leaving the
				// session without an org.
				console.error("[first-run] claim failed, creating a new org", error);
			}
		}

		let userName = user?.name;
		if (!userName) {
			userName = user?.email?.split("@")[0] || "org";
		}

		const res = await auth.api.createOrganization({
			body: {
				name: `${userName}'s Org`,
				slug: `${slugify(userName)}_${Math.floor(10000000 + Math.random() * 90000000)}`,
				userId: session.userId,
			},
		});

		return res?.id as any;
	} catch (error) {
		console.error("Error creating org", error);
		return undefined;
	}
};
