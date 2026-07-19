import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnalysisDebugPackageInput, PreparedExportHandle, PreparedPackage } from '../export'

const mocks = vi.hoisted(() => ({
  constructPreparer: vi.fn(),
  prepareAnalysisDebug: vi.fn(),
  terminatePreparer: vi.fn(),
  materializePreparedExport: vi.fn(),
  discardPreparedExport: vi.fn(),
  savePreparedPackage: vi.fn(),
  analysisReportConfigurationFromEnv: vi.fn(() => ({
    endpoint: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/analysis-report',
    publishableKey: 'sb_publishable_test',
  })),
  sendAnalysisReport: vi.fn(),
}))

vi.mock('../export', () => ({
  ExportPreparer: class MockExportPreparer {
    constructor() {
      mocks.constructPreparer()
    }

    prepareAnalysisDebug(input: AnalysisDebugPackageInput): Promise<PreparedExportHandle> {
      return mocks.prepareAnalysisDebug(input) as Promise<PreparedExportHandle>
    }

    terminate(): void {
      mocks.terminatePreparer()
    }
  },
  materializePreparedExport: mocks.materializePreparedExport,
  discardPreparedExport: mocks.discardPreparedExport,
  savePreparedPackage: mocks.savePreparedPackage,
}))

vi.mock('../report', () => ({
  analysisReportConfigurationFromEnv: mocks.analysisReportConfigurationFromEnv,
  sendAnalysisReport: mocks.sendAnalysisReport,
}))

import { useAnalysisDebugReporter } from './use-analysis-debug-reporter'

const packageId = '00000000-0000-4000-8000-000000000001'
const packageSha256 = 'a'.repeat(64)
const preparedHandle = {
  filename: 'singscope-analysis-debug.zip',
  sha256: packageSha256,
  byteLength: 3,
  location: 'memory',
  analysisDebugManifest: { packageId },
} as unknown as PreparedExportHandle
const preparedPackage: PreparedPackage = {
  blob: new Blob(['zip'], { type: 'application/zip' }),
  filename: 'singscope-analysis-debug.zip',
  sha256: packageSha256,
}
const packageInput = {} as AnalysisDebugPackageInput

function buildInput() {
  return vi.fn((): Promise<AnalysisDebugPackageInput> => Promise.resolve(packageInput))
}

beforeEach(() => {
  mocks.constructPreparer.mockClear()
  mocks.prepareAnalysisDebug.mockReset().mockResolvedValue(preparedHandle)
  mocks.terminatePreparer.mockClear()
  mocks.materializePreparedExport.mockReset().mockResolvedValue(preparedPackage)
  mocks.discardPreparedExport.mockReset().mockResolvedValue(undefined)
  mocks.savePreparedPackage.mockClear()
  mocks.sendAnalysisReport.mockReset().mockResolvedValue({
    reportId: 'SS-test-report',
    receivedAt: '2026-07-19T18:00:00.000Z',
  })
})

afterEach(() => {
  cleanup()
})

describe('useAnalysisDebugReporter', () => {
  it('does not prepare or upload when rendered or edited', () => {
    const inputBuilder = buildInput()
    const { result } = renderHook(() =>
      useAnalysisDebugReporter({
        context: 'practice-take',
        identity: 'take-a',
        buildInput: inputBuilder,
      }),
    )

    act(() => {
      result.current.setExpectedNoteCount(7)
      result.current.setIssueDescription('The guide sounded grainy.')
      result.current.setRouteCategory('speaker')
    })

    expect(result.current.view).toMatchObject({
      phase: 'idle',
      expectedNoteCount: 7,
      issueDescription: 'The guide sounded grainy.',
      routeCategory: 'speaker',
    })
    expect(inputBuilder).not.toHaveBeenCalled()
    expect(mocks.constructPreparer).not.toHaveBeenCalled()
    expect(mocks.prepareAnalysisDebug).not.toHaveBeenCalled()
    expect(mocks.materializePreparedExport).not.toHaveBeenCalled()
    expect(mocks.sendAnalysisReport).not.toHaveBeenCalled()
  })

  it('prepares and uploads only after the explicit send action', async () => {
    const inputBuilder = buildInput()
    const { result } = renderHook(() =>
      useAnalysisDebugReporter({
        context: 'practice-take',
        identity: 'take-a',
        buildInput: inputBuilder,
      }),
    )

    act(() => {
      result.current.send()
    })

    await waitFor(() => expect(result.current.view.phase).toBe('complete'))

    expect(inputBuilder).toHaveBeenCalledOnce()
    expect(inputBuilder).toHaveBeenCalledWith(expect.objectContaining({ context: 'practice-take' }))
    expect(mocks.constructPreparer).toHaveBeenCalledOnce()
    expect(mocks.prepareAnalysisDebug).toHaveBeenCalledOnce()
    expect(mocks.prepareAnalysisDebug).toHaveBeenCalledWith(packageInput)
    expect(mocks.materializePreparedExport).toHaveBeenCalledWith(preparedHandle)
    expect(mocks.sendAnalysisReport).toHaveBeenCalledOnce()
    expect(mocks.sendAnalysisReport).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/analysis-report',
      }),
      expect.objectContaining({
        blob: preparedPackage.blob,
        packageId,
        packageSha256,
        signal: expect.any(AbortSignal),
      }),
    )
    expect(result.current.view).toMatchObject({
      reportId: 'SS-test-report',
      receivedAt: '2026-07-19T18:00:00.000Z',
    })
  })

  it('does not apply an old receipt after identity changes during scratch cleanup', async () => {
    let finishCleanup: (() => void) | null = null
    mocks.discardPreparedExport.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        }),
    )
    const inputBuilder = buildInput()
    const { result, rerender } = renderHook(
      ({ identity }: { readonly identity: string }) =>
        useAnalysisDebugReporter({
          context: 'practice-take',
          identity,
          buildInput: inputBuilder,
        }),
      { initialProps: { identity: 'take-a' } },
    )

    act(() => {
      result.current.send()
    })
    await waitFor(() => expect(mocks.discardPreparedExport).toHaveBeenCalledWith(preparedHandle))

    rerender({ identity: 'take-b' })
    await waitFor(() => {
      expect(result.current.view.phase).toBe('idle')
      expect(result.current.view.reportId).toBeNull()
    })

    await act(async () => {
      finishCleanup?.()
      await Promise.resolve()
    })

    expect(result.current.view.phase).toBe('idle')
    expect(result.current.view.reportId).toBeNull()
  })
})
