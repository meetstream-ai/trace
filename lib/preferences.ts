import { z } from "zod";
export const preferencesSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200).or(z.literal("")),
  workspaceName: z.string().trim().min(1).max(80),
  defaultProject: z.string().trim().max(100),
  meetingSort: z.enum([
    "newest",
    "oldest",
    "alphabetical",
    "duration",
    "review",
  ]),
  revision: z.number().int().min(0),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences: Preferences = {
  displayName: "Workspace member",
  email: "",
  workspaceName: "Engineering",
  defaultProject: "",
  meetingSort: "newest",
  revision: 0,
};
export const meetingSorts = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "alphabetical", label: "Title A–Z" },
  { id: "duration", label: "Longest first" },
  { id: "review", label: "Needs review first" },
] as const;
