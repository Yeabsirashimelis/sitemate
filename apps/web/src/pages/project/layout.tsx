import { NavLink, Outlet, useOutletContext, useParams } from "react-router";
import { ErrorNote, Loading, PageHeader, cx } from "../../components/ui";
import { dayDate } from "../../lib/format";
import { useProject } from "../../lib/queries";
import type { Project, ProjectMember } from "../../lib/types";

const TABS = [
  { to: "", label: "Overview" },
  { to: "schedule", label: "Schedule" },
  { to: "lookahead", label: "Look ahead" },
  { to: "materials", label: "Materials" },
  { to: "cost", label: "Cost" },
  { to: "claims", label: "Claims" },
  { to: "logs", label: "Daily logs" },
  { to: "documents", label: "Documents" },
  { to: "activity", label: "Agent activity" },
];

export interface ProjectContext {
  project: Project;
  members: ProjectMember[];
}

export function useProjectContext(): ProjectContext {
  return useOutletContext<ProjectContext>();
}

export function ProjectLayout() {
  const { projectId = "" } = useParams();
  const { data, isLoading, error } = useProject(projectId);

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorNote error={error ?? new Error("Project not found")} />;
  const { project } = data;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageHeader
          eyebrow={project.locationName ?? "Project"}
          title={project.name}
          meta={
            <span className="flex flex-wrap gap-x-4 gap-y-1">
              {project.client ? <span>Client {project.client}</span> : null}
              {project.consultant ? <span>Engineer {project.consultant}</span> : null}
              <span>Status as of {dayDate(project.dataDate)}</span>
            </span>
          }
        />
        <nav className="-mb-px flex gap-1 overflow-x-auto border-b border-rule" aria-label="Project sections">
          {TABS.map((tab) => (
            <NavLink
              key={tab.label}
              to={tab.to ? `/projects/${projectId}/${tab.to}` : `/projects/${projectId}`}
              end={tab.to === ""}
              className={({ isActive }) =>
                cx(
                  "whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] transition-colors",
                  isActive ? "border-ink font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink",
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <Outlet context={data satisfies ProjectContext} />
    </div>
  );
}
