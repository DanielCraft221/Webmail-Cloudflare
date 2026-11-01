import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

/** Provisional home (Etapa 6 brings the mailboxes). */
export const load: PageServerLoad = ({ locals }) => {
  if (!locals.user) redirect(303, "/login");
  return {
    username: locals.user.username,
    displayName: locals.user.displayName,
  };
};
