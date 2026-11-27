import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isPickableProjectMember,
  isRepositoryRootProject,
  pickableProjectGroups,
  selectGroupDefaultProject,
  sortProjectsByGroupOrder,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { repositoryGroupingKeyOf, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

type ProjectRef = { readonly environmentId: string; readonly projectId: string };

type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" }
  | { readonly kind: "dismiss" };

function selectOpenProjectScopeMember(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
  lastProject?: ProjectRef,
): EnvironmentProject | undefined {
  const open = scope.projects.filter(isPickableProjectMember);
  const remembered =
    lastProject &&
    open.find(
      (project) =>
        project.environmentId === lastProject.environmentId && project.id === lastProject.projectId,
    );
  if (remembered) return remembered;

  const rank = (project: EnvironmentProject) =>
    project.environmentId === preferredEnvironmentId ? 0 : project === scope.representative ? 1 : 2;
  open.sort(
    (left, right) =>
      rank(left) - rank(right) ||
      Number(isRepositoryRootProject(right)) - Number(isRepositoryRootProject(left)),
  );
  return open.find((project) => connectedEnvironmentIds.has(project.environmentId)) ?? open[0];
}

/**
 * Picker scopes have an open copy; prefer a connected one, then the selected environment, with a
 * repository root ahead of a sub-folder.
 */
export function getProjectScopeSelectionTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
): EnvironmentProject {
  const project = selectOpenProjectScopeMember(
    scope,
    preferredEnvironmentId,
    connectedEnvironmentIds,
  );
  if (!project) throw new Error("A pickable project group must have an open workspace");
  return project;
}

export function filterProjectScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  searchText: string,
): ReadonlyArray<HomeProjectScope> {
  const query = searchText.trim().toLowerCase();
  if (!query) return scopes;
  return scopes.filter(
    (scope) =>
      scope.title.toLowerCase().includes(query) ||
      scope.projects.some(
        (project) =>
          project.title.toLowerCase().includes(query) ||
          project.workspaceRoot.toLowerCase().includes(query),
      ),
  );
}

// Cached configuration reserves the row; connection readiness only gates activation.
export function resolveNewTaskScratchOption(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  }>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "scratchWorkspaceRoot">>;
  readonly selectedEnvironmentId: EnvironmentId | null;
}) {
  const offering = input.environments.filter(
    (environment) =>
      (input.serverConfigs.get(environment.environmentId)?.scratchWorkspaceRoot ?? null) !== null,
  );
  const ready = offering.filter(
    (environment) =>
      availableScratchWorkspaceRoot(
        environment.connectionState,
        input.serverConfigs.get(environment.environmentId),
      ) !== null,
  );
  const candidates = ready.length > 0 ? ready : offering;
  const environment =
    candidates.find((candidate) => candidate.environmentId === input.selectedEnvironmentId) ??
    candidates[0];
  return environment ? { environmentId: environment.environmentId, ready: ready.length > 0 } : null;
}

export function resolveEnvironmentProjectMatch(
  projectsOnTarget: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
): EnvironmentProject | null {
  const repositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  // Use || null: placeholder workspaceRoot can be empty, which supplies no useful basename.
  const workspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  // Use weaker signals only when identity is unknown; different known repositories never match by basename or title.
  const isKnownMismatch = (project: EnvironmentProject) => {
    const projectKey = project.repositoryIdentity
      ? repositoryGroupingKeyOf(project.repositoryIdentity)
      : null;
    return repositoryKey !== null && projectKey !== null && projectKey !== repositoryKey;
  };
  return (
    (repositoryKey !== null
      ? projectsOnTarget.find(
          (project) =>
            (project.repositoryIdentity
              ? repositoryGroupingKeyOf(project.repositoryIdentity)
              : null) === repositoryKey,
        )
      : undefined) ??
    (workspaceBasename !== null
      ? projectsOnTarget.find(
          (project) =>
            !isKnownMismatch(project) &&
            project.workspaceRoot.split("/").at(-1) === workspaceBasename,
        )
      : undefined) ??
    (selectedProject !== null
      ? projectsOnTarget.find(
          (project) => !isKnownMismatch(project) && project.title === selectedProject.title,
        )
      : undefined) ??
    projectsOnTarget[0] ??
    null
  );
}

/** Both projects have a known repository identity, and it is the same one. */
export function isSameRepository(
  left: EnvironmentProject | null,
  right: EnvironmentProject | null,
): boolean {
  return (
    left?.repositoryIdentity != null &&
    right?.repositoryIdentity != null &&
    repositoryGroupingKeyOf(left.repositoryIdentity) ===
      repositoryGroupingKeyOf(right.repositoryIdentity)
  );
}

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
  projectScopes: ReadonlyArray<HomeProjectScope>,
  draft: {
    readonly incomingShareId: string | undefined;
    /** The draft's first project picker closed and the draft is showing again. */
    readonly pickerClosed: boolean;
    readonly useLastProject?: boolean | undefined;
    readonly lastProject?: ProjectRef | undefined;
    /** The machine chosen in settings, already resolved to null unless it is connected. */
    readonly defaultEnvironmentId?: EnvironmentId | null | undefined;
  },
): DraftProjectSelectionResolution {
  const hasExplicitProjectSelection =
    selectedProjectKey !== null &&
    projects.some(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    );
  if (hasExplicitProjectSelection) {
    return { kind: "preserve" };
  }
  // A share draft holds content the user sent here, so cancelling the picker must not drop it.
  if (draft.pickerClosed && selectedProjectKey === null && draft.incomingShareId === undefined) {
    return { kind: "dismiss" };
  }

  if (draft.incomingShareId === undefined) {
    return { kind: "pick" };
  }
  const openScopes = pickableProjectGroups(projectScopes);
  const start =
    draft.useLastProject === false
      ? undefined
      : resolveNewTaskStartProject({
          projects,
          defaultEnvironmentId: draft.defaultEnvironmentId ?? null,
          projectGroups: projectScopes.map((scope) => ({
            memberProjectRefs: scope.projectRefs,
            pinned: scope.pinned,
            archived: scope.archived,
          })),
          lastProject: draft.lastProject,
        });
  if (start) {
    return { kind: "select", project: start };
  }
  const onlyScope = openScopes.length === 1 ? openScopes[0] : null;
  return onlyScope ? { kind: "select", project: onlyScope.representative } : { kind: "pick" };
}

/** The live copy of the thread list's filtered project a new thread starts in: the remembered one if it is a copy. */
export function newTaskFilteredProject(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
  lastProject: ProjectRef | undefined,
): ProjectRef | undefined {
  const project = selectOpenProjectScopeMember(
    scope,
    preferredEnvironmentId,
    connectedEnvironmentIds,
    lastProject,
  );
  return project && { environmentId: project.environmentId, projectId: project.id };
}

type ProjectGroupsForOrder = Parameters<typeof sortProjectsByGroupOrder>[1];

/**
 * Where a new task starts when nothing narrows it: the default machine's first open project (its
 * remembered one first), else the remembered project. Archived groups are never picked.
 */
function resolveNewTaskStartProject(options: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly defaultEnvironmentId: EnvironmentId | null;
  readonly projectGroups: ProjectGroupsForOrder | undefined;
  readonly lastProject: ProjectRef | undefined;
}): EnvironmentProject | undefined {
  const { defaultEnvironmentId } = options;
  const groups = options.projectGroups ?? [];
  const last =
    options.lastProject &&
    options.projects.find(
      (project) =>
        project.environmentId === options.lastProject?.environmentId &&
        project.id === options.lastProject.projectId,
    );
  const inGroup = (
    group: ProjectGroupsForOrder[number],
    project: Pick<EnvironmentProject, "environmentId" | "id">,
  ) =>
    group.memberProjectRefs.some(
      (ref) => ref.environmentId === project.environmentId && ref.projectId === project.id,
    );
  const openGroups = pickableProjectGroups(groups);
  const inArchivedGroup = (project: Pick<EnvironmentProject, "environmentId" | "id">) =>
    groups.some((group) => group.archived && inGroup(group, project));
  const onDefaultEnvironment = defaultEnvironmentId
    ? sortProjectsByGroupOrder(
        options.projects.filter(
          (candidate) =>
            candidate.environmentId === defaultEnvironmentId &&
            candidate.archivedAt == null &&
            !inArchivedGroup(candidate),
        ),
        groups,
      )
    : [];
  const lastOnDefaultEnvironment = onDefaultEnvironment.find((candidate) => candidate === last);
  // Members of one group rank alike, so the first of them may be a subfolder: take the group's root.
  const firstProject = onDefaultEnvironment[0];
  const firstGroup = firstProject
    ? openGroups.find((group) => inGroup(group, firstProject))
    : undefined;
  const firstOnDefaultEnvironment = firstGroup
    ? selectGroupDefaultProject(
        onDefaultEnvironment.filter((candidate) => inGroup(firstGroup, candidate)),
      )
    : firstProject;
  return (
    lastOnDefaultEnvironment ??
    firstOnDefaultEnvironment ??
    (last && last.archivedAt == null && !inArchivedGroup(last) ? last : undefined)
  );
}

export function newTaskDestination(options: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly requestId: string;
  readonly useLastProject: boolean | undefined;
  readonly currentProject: ProjectRef | undefined;
  readonly filteredProject: ProjectRef | undefined;
  /** The machine chosen in settings: with no current or filtered project, its projects come first. */
  readonly defaultEnvironmentId?: EnvironmentId | null | undefined;
  /** An offline default machine cannot send, so it applies only while connected. */
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  /** The sidebar's project order, as the web picks its default: the first of these on the machine wins. */
  readonly projectGroups?: Parameters<typeof sortProjectsByGroupOrder>[1] | undefined;
  readonly lastProject: ProjectRef | undefined;
}) {
  const find = (ref: ProjectRef | undefined) =>
    ref &&
    options.projects.find(
      (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
    );
  const { defaultEnvironmentId: savedDefault, connectedEnvironmentIds } = options;
  const defaultEnvironmentId =
    savedDefault && connectedEnvironmentIds.has(savedDefault) ? savedDefault : null;
  const project =
    options.useLastProject === false
      ? undefined
      : (find(options.currentProject) ??
        find(options.filteredProject) ??
        resolveNewTaskStartProject({
          projects: options.projects,
          defaultEnvironmentId,
          projectGroups: options.projectGroups,
          lastProject: options.lastProject,
        }));
  return project
    ? {
        draft: {
          requestId: options.requestId,
          environmentId: String(project.environmentId),
          projectId: String(project.id),
        },
      }
    : { draft: { requestId: options.requestId } };
}
