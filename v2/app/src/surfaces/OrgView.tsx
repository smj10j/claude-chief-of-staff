import { useMemo } from "react";

export type OrgNode = {
  id: string;
  label: string;
  title?: string | null;
  slug?: string | null;
  parent?: string | null;
  is_self?: boolean;
  has_folder?: boolean;
  relationship?: string | null;
  rel_path?: string | null;
  last_session?: string | null;
};

export type OrgView = {
  id: string;
  label: string;
  description?: string;
  hierarchy: OrgNode[];
  partners: OrgNode[];
};

type TreeNode = OrgNode & { children: TreeNode[] };

export function OrgViewPanel({
  view,
  onGoToProfile,
}: {
  view: OrgView;
  onGoToProfile: (node: OrgNode) => void;
}) {
  const tree = useMemo(() => buildTree(view.hierarchy), [view.hierarchy]);

  const openPerson = (n: OrgNode) => {
    if (!n.has_folder || !n.rel_path) return;
    onGoToProfile(n);
  };

  return (
    <div className="cos-org-view">
      {view.description && (
        <p className="cos-section-lede">{view.description}</p>
      )}

      {tree.length === 0 && view.partners.length === 0 && (
        <div className="cos-empty">
          No people in this view yet. Edit{" "}
          <code>data/files/areas/org/org.json</code> or (soon) use the
          generator below.
        </div>
      )}

      {tree.length > 0 && (
        <div className="cos-org-hierarchy">
          {tree.map((n) => (
            <OrgBranch key={n.id} node={n} depth={0} onOpen={openPerson} />
          ))}
        </div>
      )}

      {view.partners.length > 0 && (
        <div className="cos-org-partners">
          <h3>Partners</h3>
          <ul className="cos-org-partner-list">
            {view.partners.map((p) => (
              <li key={p.id}>
                <OrgEntry node={p} onOpen={openPerson} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function OrgBranch({
  node,
  depth,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  onOpen: (n: OrgNode) => void;
}) {
  return (
    <div className="cos-org-branch" style={{ paddingLeft: depth * 20 }}>
      <OrgEntry node={node} onOpen={onOpen} />
      {node.children.length > 0 && (
        <div className="cos-org-children">
          {node.children.map((c) => (
            <OrgBranch
              key={c.id}
              node={c}
              depth={depth + 1}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrgEntry({
  node,
  onOpen,
}: {
  node: OrgNode;
  onOpen: (n: OrgNode) => void;
}) {
  const clickable = node.has_folder === true && !node.is_self;
  const className = [
    "cos-org-entry",
    node.is_self ? "cos-org-entry-self" : "",
    clickable ? "cos-org-entry-clickable" : "cos-org-entry-static",
    node.has_folder === false && !node.is_self ? "cos-org-entry-missing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <span className="cos-org-name">{node.label}</span>
      {node.title && <span className="cos-org-title">{node.title}</span>}
      {clickable && node.last_session && (
        <span className="cos-org-session" title={node.last_session}>
          last: {node.last_session}
        </span>
      )}
      {!clickable && !node.is_self && (
        <span className="cos-org-no-folder">no 1:1</span>
      )}
    </>
  );

  if (!clickable) {
    return <div className={className}>{body}</div>;
  }
  return (
    <button
      type="button"
      className={className}
      onClick={() => onOpen(node)}
      title={`Open ${node.label}'s latest session`}
    >
      {body}
    </button>
  );
}

function buildTree(nodes: OrgNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const n of nodes) {
    byId.set(n.id, { ...n, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const n of byId.values()) {
    if (n.parent && byId.has(n.parent)) {
      byId.get(n.parent)!.children.push(n);
    } else {
      roots.push(n);
    }
  }
  // Sort children deterministically: self first (so you-then-reports reads
  // top-down), then alphabetical by label. Roots follow the same rule.
  const sort = (a: TreeNode, b: TreeNode) => {
    if (a.is_self !== b.is_self) return a.is_self ? -1 : 1;
    return a.label.localeCompare(b.label);
  };
  for (const n of byId.values()) n.children.sort(sort);
  roots.sort(sort);
  return roots;
}
