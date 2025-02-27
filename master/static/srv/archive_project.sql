WITH p AS (
  SELECT id, workspace_id FROM projects
  WHERE id = $1
  AND NOT immutable
),
w AS (
  SELECT workspaces.id, workspaces.user_id FROM p, workspaces
  WHERE workspaces.id = p.workspace_id
  AND NOT workspaces.archived
)
UPDATE projects SET archived = $2
  WHERE projects.id = (SELECT id FROM p)
  AND workspace_id = (SELECT id FROM w)
  AND ($4 IS TRUE OR user_id = $3 OR (SELECT user_id FROM w) = $3)
RETURNING id;
