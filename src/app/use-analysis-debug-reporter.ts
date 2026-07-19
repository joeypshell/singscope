import { useCallback, useEffect, useRef, useState } from 'react'

import {
  discardPreparedExport,
  ExportPreparer,
  materializePreparedExport,
  savePreparedPackage,
  type AnalysisDebugPackageInput,
  type PreparedExportHandle,
  type PreparedPackage,
} from '../export'
import { analysisReportConfigurationFromEnv, sendAnalysisReport } from '../report'
import type { AnalysisDebugContext, AnalysisDebugRouteCategory, AnalysisDebugView } from './types'

const REPORT_TIMEOUT_MS = 120_000
const REPORT_CONFIGURATION = analysisReportConfigurationFromEnv({
  VITE_SINGSCOPE_REPORT_ENDPOINT: import.meta.env.VITE_SINGSCOPE_REPORT_ENDPOINT,
  VITE_SINGSCOPE_REPORT_PUBLISHABLE_KEY: import.meta.env.VITE_SINGSCOPE_REPORT_PUBLISHABLE_KEY,
})

interface PreparedAnalysisDebug {
  readonly handle: PreparedExportHandle
  readonly packageValue: PreparedPackage
}

export interface AnalysisDebugReporter {
  readonly view: AnalysisDebugView
  readonly send: () => void
  readonly savePackage: () => void
  readonly setExpectedNoteCount: (count: number | null) => void
  readonly setIssueDescription: (description: string) => void
  readonly setRouteCategory: (route: AnalysisDebugRouteCategory) => void
}

export interface AnalysisDebugReporterOptions {
  readonly context: AnalysisDebugContext
  readonly identity: string
  readonly buildInput: (view: AnalysisDebugView) => Promise<AnalysisDebugPackageInput>
}

function initialView(context: AnalysisDebugContext): AnalysisDebugView {
  return {
    context,
    phase: 'idle',
    reportingAvailable: REPORT_CONFIGURATION !== null,
    canSavePackage: false,
    packageSizeLabel: null,
    errorMessage: null,
    reportId: null,
    receivedAt: null,
    expectedNoteCount: null,
    issueDescription: '',
    routeCategory: 'unknown',
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The bug report could not be prepared.'
}

function packageSizeLabel(byteLength: number): string {
  const mebibytes = byteLength / (1024 * 1024)
  return mebibytes >= 1
    ? `${mebibytes.toFixed(1)} MiB`
    : `${Math.max(1, Math.ceil(byteLength / 1024)).toString()} KiB`
}

/**
 * Shared, explicit-only report sender. Calling the hook, opening its panel, or
 * editing fields never starts a network request; only `send` does.
 */
export function useAnalysisDebugReporter({
  context,
  identity,
  buildInput,
}: AnalysisDebugReporterOptions): AnalysisDebugReporter {
  const [view, setView] = useState<AnalysisDebugView>(() => initialView(context))
  const preparedRef = useRef<PreparedAnalysisDebug | null>(null)
  const preparerRef = useRef<ExportPreparer | null>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)

  const releasePrepared = useCallback(() => {
    generationRef.current += 1
    uploadAbortRef.current?.abort()
    uploadAbortRef.current = null
    preparerRef.current?.terminate()
    preparerRef.current = null
    const prepared = preparedRef.current
    preparedRef.current = null
    if (prepared) void discardPreparedExport(prepared.handle).catch(() => undefined)
  }, [])

  useEffect(() => releasePrepared, [releasePrepared])
  useEffect(() => {
    releasePrepared()
    setView(initialView(context))
  }, [context, identity, releasePrepared])

  const resetForEdit = useCallback(
    (patch: Partial<AnalysisDebugView>) => {
      releasePrepared()
      setView((current) => ({
        ...current,
        ...patch,
        phase: 'idle',
        canSavePackage: false,
        packageSizeLabel: null,
        errorMessage: null,
        reportId: null,
        receivedAt: null,
      }))
    },
    [releasePrepared],
  )

  const uploadPrepared = useCallback((prepared: PreparedAnalysisDebug, generation: number) => {
    const configuration = REPORT_CONFIGURATION
    const manifest = prepared.handle.analysisDebugManifest
    if (configuration === null || manifest === undefined) {
      setView((current) => ({
        ...current,
        phase: 'error',
        canSavePackage: true,
        packageSizeLabel: packageSizeLabel(prepared.handle.byteLength),
        errorMessage:
          configuration === null
            ? 'Direct reporting is not configured in this build.'
            : 'The prepared package is missing its report identity. Save it locally and try again.',
        reportId: null,
        receivedAt: null,
      }))
      return
    }

    const abortController = new AbortController()
    let timedOut = false
    const timeoutId = window.setTimeout(() => {
      timedOut = true
      abortController.abort()
    }, REPORT_TIMEOUT_MS)
    uploadAbortRef.current = abortController
    setView((current) => ({
      ...current,
      phase: 'uploading',
      canSavePackage: true,
      packageSizeLabel: packageSizeLabel(prepared.handle.byteLength),
      errorMessage: null,
      reportId: null,
      receivedAt: null,
    }))

    void (async () => {
      try {
        const receipt = await sendAnalysisReport(configuration, {
          blob: prepared.packageValue.blob,
          packageId: manifest.packageId,
          packageSha256: prepared.packageValue.sha256,
          signal: abortController.signal,
        })
        if (generation !== generationRef.current) return
        if (preparedRef.current === prepared) preparedRef.current = null
        setView((current) => ({
          ...current,
          phase: 'complete',
          canSavePackage: false,
          errorMessage: null,
          reportId: receipt.reportId,
          receivedAt: receipt.receivedAt,
        }))
        await discardPreparedExport(prepared.handle).catch(() => undefined)
      } catch (error) {
        if (generation !== generationRef.current) return
        setView((current) => ({
          ...current,
          phase: 'error',
          canSavePackage: true,
          errorMessage: timedOut
            ? 'Sending timed out, so delivery was not confirmed. The service may already have received the package; retrying is safe because the package ID is unchanged, and nothing will be sent later in the background.'
            : asMessage(error),
          reportId: null,
          receivedAt: null,
        }))
      } finally {
        window.clearTimeout(timeoutId)
        if (uploadAbortRef.current === abortController) uploadAbortRef.current = null
      }
    })()
  }, [])

  const send = useCallback(() => {
    if (REPORT_CONFIGURATION === null) {
      setView((current) => ({
        ...current,
        phase: 'error',
        canSavePackage: false,
        packageSizeLabel: null,
        errorMessage: 'Direct reporting is not configured in this build.',
        reportId: null,
        receivedAt: null,
      }))
      return
    }
    const existing = preparedRef.current
    if (existing) {
      uploadPrepared(existing, generationRef.current)
      return
    }

    releasePrepared()
    const generation = generationRef.current
    const reportView = view
    setView((current) => ({
      ...current,
      phase: 'preparing',
      canSavePackage: false,
      packageSizeLabel: null,
      errorMessage: null,
      reportId: null,
      receivedAt: null,
    }))
    const preparer = new ExportPreparer()
    preparerRef.current = preparer
    void (async () => {
      let handle: PreparedExportHandle | null = null
      try {
        const input = await buildInput(reportView)
        const preparedHandle = await preparer.prepareAnalysisDebug(input)
        handle = preparedHandle
        const packageValue = await materializePreparedExport(preparedHandle)
        if (generation !== generationRef.current) {
          await discardPreparedExport(preparedHandle).catch(() => undefined)
          return
        }
        const prepared = { handle: preparedHandle, packageValue }
        preparedRef.current = prepared
        uploadPrepared(prepared, generation)
      } catch (error) {
        if (handle) await discardPreparedExport(handle).catch(() => undefined)
        if (generation !== generationRef.current) return
        setView((current) => ({
          ...current,
          phase: 'error',
          canSavePackage: false,
          packageSizeLabel: null,
          errorMessage: asMessage(error),
          reportId: null,
          receivedAt: null,
        }))
      } finally {
        preparer.terminate()
        if (preparerRef.current === preparer) preparerRef.current = null
      }
    })()
  }, [buildInput, releasePrepared, uploadPrepared, view])

  const savePackage = useCallback(() => {
    const prepared = preparedRef.current
    if (!prepared) {
      setView((current) => ({
        ...current,
        phase: 'error',
        canSavePackage: false,
        errorMessage: 'Send the report again to prepare a package before saving it.',
      }))
      return
    }
    try {
      savePreparedPackage(prepared.packageValue)
      setView((current) => ({
        ...current,
        errorMessage:
          'A local debug package was saved. Delivery was not confirmed, so the service may still have received the report.',
      }))
    } catch (error) {
      setView((current) => ({ ...current, errorMessage: asMessage(error) }))
    }
  }, [])

  return {
    view,
    send,
    savePackage,
    setExpectedNoteCount: (count) =>
      resetForEdit({
        expectedNoteCount: count === null ? null : Math.max(1, Math.min(100, Math.trunc(count))),
      }),
    setIssueDescription: (issueDescription) => resetForEdit({ issueDescription }),
    setRouteCategory: (routeCategory) => resetForEdit({ routeCategory }),
  }
}
