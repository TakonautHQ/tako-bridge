/**
 * Mirrors the server's own cap on what the Planner may ever be granted:
 * backend/src/services/agent_profile_template_seeds.py's
 * `_PLANNER_ALLOWED_GRANTS` (the planner-v1 Profile Template's allowed
 * grant keys), resolved through backend/src/services/ai/agent_tools/catalog.py's
 * per-grant `mcp_tools` to the exact MCP tool names those grants cover.
 *
 * Defense in depth (M2): the server resolves a turn's `granted_tools` from
 * whichever Profile is published as "Planner" for the Project, so a Profile
 * editor widening it, or a server bug, is the only thing standing between a
 * planning turn and tools far outside "read-only analysis". This set is
 * this process's own, independent backstop against that: it is applied in
 * `planner-tools-extension.ts` on top of (never instead of) the server's
 * `granted_tools`, so dropping a tool here only ever narrows access.
 *
 * Covered by `test/planner-allowed-tools.test.ts`, which re-derives this
 * same set from the backend source files above and asserts no drift.
 */
export const PLANNER_ALLOWED_MCP_TOOLS: ReadonlySet<string> = new Set([
	// tasks.read
	"get_board",
	"get_sprint",
	"get_sprint_summary",
	"list_tasks",
	"get_task",
	"list_work_hierarchy_levels",
	"list_work_items",
	"get_work_item",
	"get_work_item_dependencies",
	"get_task_dependencies",
	"get_sprint_blockers",
	// projects.read
	"list_projects",
	"list_users",
	// work_documents.read
	"list_work_documents",
	"get_work_document",
	"list_document_change_requests",
	// document_library.read
	"get_document_library_snapshot",
	"search_work_documents",
	"get_document_folder_public_share",
	"list_work_document_revisions",
	"compare_work_document_revisions",
	"list_work_document_audit_trail",
	"get_work_document_delete_decision",
	"export_work_document",
	// project_context.read
	"list_project_context_repositories",
	"discover_project_context",
	"expand_project_evidence",
	// tako_grill.read
	"get_tako_grill_session",
	"get_tako_grill_interview",
	"get_tako_grill_context",
	"get_tako_grill_proposal",
	"list_tako_grill_decisions",
	// comments.read
	"list_comment_threads",
	"count_open_comment_threads",
	"get_comment_thread",
	// adrs.read
	"get_adrs_in_force",
	// work_documents.write
	"create_work_document",
	"update_work_document",
	"set_work_document_placement",
	"draft_work_document_from_guidance",
	"rewrite_work_document_blocks",
	// mockups.write
	"create_mockup",
	"save_mockup_draft",
	"discard_mockup_draft",
	"rename_mockup",
	"restore_mockup_version",
	"upload_mockup_image",
	// tako_grill.write
	"record_tako_grill_round",
	"record_tako_grill_decision",
	"mark_tako_grill_question_open",
	"create_tako_grill_proposal",
	"append_tako_grill_proposal_actions",
	"edit_tako_grill_proposal_action",
	// comments.write
	"create_comment_thread",
	"reply_to_comment_thread",
	"edit_comment",
	// comments.address
	"mark_comment_thread_addressed",
	"reanchor_comment_threads",
]);
