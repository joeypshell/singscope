import { create } from 'zustand'

import { createRepositories, getDatabase, type JsonValue } from '../persistence'
import { appProjectSchema } from './project-schema'
import type { AppLoop, AppProject, AppTake } from './types'

type StorageState = 'checking' | 'ready' | 'limited' | 'failed'

interface AppState {
  projects: readonly AppProject[]
  activeProjectId: string | null
  storageState: StorageState
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  message: string | null
  hydrated: boolean
  hydrate(): Promise<void>
  putProject(project: AppProject): Promise<void>
  deleteProject(id: string): Promise<void>
  setActiveProject(id: string | null): void
  addTake(projectId: string, take: AppTake): Promise<void>
  updateLoop(projectId: string, loop: AppLoop): Promise<void>
  updateTimingOffset(projectId: string, seconds: number): Promise<void>
  markBackedUp(projectId: string): Promise<void>
  setStorageState(state: StorageState, message?: string | null): void
  setMessage(message: string | null): void
}

const repositories = () => createRepositories(getDatabase())

function toPayload(project: AppProject): JsonValue {
  return JSON.parse(JSON.stringify(project)) as JsonValue
}

function updated(project: AppProject, patch: Partial<AppProject>): AppProject {
  return appProjectSchema.parse({ ...project, ...patch, updatedAt: new Date().toISOString() })
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  storageState: 'checking',
  saveState: 'idle',
  message: null,
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return
    try {
      const records = await repositories().projects.list()
      const projects = records.flatMap((record) => {
        const result = appProjectSchema.safeParse(record.payload)
        return result.success ? [result.data] : []
      })
      set({ projects, hydrated: true, saveState: 'idle' })
    } catch (error) {
      set({
        hydrated: true,
        saveState: 'error',
        message: error instanceof Error ? error.message : 'Projects could not be loaded.',
      })
    }
  },

  async putProject(input) {
    const project = appProjectSchema.parse(input)
    set({ saveState: 'saving' })
    try {
      await repositories().projects.put({
        id: project.id,
        schemaVersion: project.schemaVersion,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        payload: toPayload(project),
      })
      set((state) => ({
        projects: [
          ...state.projects.filter((candidate) => candidate.id !== project.id),
          project,
        ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        saveState: 'saved',
        message: null,
      }))
    } catch (error) {
      set({
        saveState: 'error',
        message: error instanceof Error ? error.message : 'Project could not be saved.',
      })
      throw error
    }
  },

  async deleteProject(id) {
    await repositories().projects.delete(id)
    set((state) => ({
      projects: state.projects.filter((project) => project.id !== id),
      activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
    }))
  },

  setActiveProject(activeProjectId) {
    set({ activeProjectId })
  },

  async addTake(projectId, take) {
    const project = get().projects.find((candidate) => candidate.id === projectId)
    if (!project) throw new Error('Project no longer exists.')
    await get().putProject(updated(project, { takes: [...project.takes, take] }))
  },

  async updateLoop(projectId, loop) {
    const project = get().projects.find((candidate) => candidate.id === projectId)
    if (!project) throw new Error('Project no longer exists.')
    const loops = project.loops.some((candidate) => candidate.id === loop.id)
      ? project.loops.map((candidate) => (candidate.id === loop.id ? loop : candidate))
      : [...project.loops, loop]
    await get().putProject(updated(project, { loops }))
  },

  async updateTimingOffset(projectId, seconds) {
    const project = get().projects.find((candidate) => candidate.id === projectId)
    if (!project) throw new Error('Project no longer exists.')
    await get().putProject(updated(project, { timingOffsetSeconds: seconds }))
  },

  async markBackedUp(projectId) {
    const project = get().projects.find((candidate) => candidate.id === projectId)
    if (!project) throw new Error('Project no longer exists.')
    await get().putProject(updated(project, { lastBackupAt: new Date().toISOString() }))
  },

  setStorageState(storageState, message = null) {
    set({ storageState, message })
  },

  setMessage(message) {
    set({ message })
  },
}))

export function activeProject(
  state: Pick<AppState, 'projects' | 'activeProjectId'>,
): AppProject | null {
  return state.projects.find((project) => project.id === state.activeProjectId) ?? null
}
