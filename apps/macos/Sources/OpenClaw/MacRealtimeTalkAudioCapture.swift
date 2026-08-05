import AudioToolbox
@preconcurrency import AVFoundation
import CoreAudio
import Foundation
import OpenClawKit
import OSLog

@MainActor
final class MacRealtimeTalkAudioCapture: RealtimeTalkAudioCapturing {
    private static let frameBufferSize: AVAudioFrameCount = 2048

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.realtime.capture")
    private let selectedInputUID: @MainActor () -> String?
    private let onFailure: @MainActor (Error) -> Void
    private let deliveryGate = MacRealtimeTalkCaptureDeliveryGate()

    private var audioEngine: AVAudioEngine?
    private var inputNode: AVAudioInputNode?
    private var audioInputObserver: AudioInputDeviceObserver?
    private var audioOutputObserver: MacRealtimeTalkOutputRouteObserver?
    private var activeInputResolution: AudioInputDeviceResolution?
    private var targetSampleRate: Double?
    private var onAudio: (@Sendable (RealtimeTalkAudioFrame) -> Void)?
    private var tapInstalled = false
    private var failureReported = false
    private var suppressInputDuringOutput = false

    var suppressesInputDuringOutput: Bool {
        self.suppressInputDuringOutput
    }

    init(
        selectedInputUID: @escaping @MainActor () -> String? = {
            AppStateStore.shared.voiceWakeMicID
        },
        onFailure: @escaping @MainActor (Error) -> Void = { _ in })
    {
        self.selectedInputUID = selectedInputUID
        self.onFailure = onFailure
    }

    @MainActor deinit {
        self.stop()
    }

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void) throws
    {
        guard targetSampleRate.isFinite, targetSampleRate > 0 else {
            throw MacRealtimeTalkAudioCaptureError.invalidTargetSampleRate
        }

        self.stop()
        self.failureReported = false
        self.targetSampleRate = targetSampleRate
        self.onAudio = onAudio
        self.startOutputRouteObserver()
        do {
            try self.startCaptureEngine(targetSampleRate: targetSampleRate, onAudio: onAudio)
            self.startDeviceObserver()
        } catch {
            self.stop()
            throw error
        }
    }

    func stop() {
        // Close delivery before removing the tap. A callback already running on Core Audio's
        // queue must finish before stop returns, and later callbacks must drop their frames.
        self.deliveryGate.deactivate()
        self.audioInputObserver?.stop()
        self.audioInputObserver = nil
        self.audioOutputObserver?.stop()
        self.audioOutputObserver = nil
        self.suppressInputDuringOutput = false
        self.teardownEngine()
        self.targetSampleRate = nil
        self.onAudio = nil
    }

    private func startCaptureEngine(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void) throws
    {
        let selection = AudioInputDeviceObserver.resolveSelection(self.selectedInputUID())
        // AVAudioEngine materializes inputNode from the system default before CurrentDevice can bind.
        // Without a usable default, accessing inputNode can SIGABRT even when another UID is alive.
        guard selection.resolvedUID != nil, AudioInputDeviceObserver.hasUsableDefaultInputDevice() else {
            throw MacRealtimeTalkAudioCaptureError.inputUnavailable
        }

        do {
            try self.configureEngine(
                selection: selection,
                targetSampleRate: targetSampleRate,
                onAudio: onAudio,
                enableVoiceProcessing: true)
        } catch {
            self.logger.warning(
                "realtime processed input setup failed; retrying without voice processing: " +
                    "\(error.localizedDescription, privacy: .public)")
            self.deliveryGate.deactivate()
            self.teardownEngine()
            try self.configureEngine(
                selection: selection,
                targetSampleRate: targetSampleRate,
                onAudio: onAudio,
                enableVoiceProcessing: false)
        }
    }

    private func configureEngine(
        selection: AudioInputDeviceResolution,
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        enableVoiceProcessing: Bool) throws
    {
        let engine = AVAudioEngine()
        self.audioEngine = engine
        let input = engine.inputNode
        self.inputNode = input

        if enableVoiceProcessing {
            try input.setVoiceProcessingEnabled(true)
        }

        let activeResolution = self.bindSelectedInputIfNeeded(selection, to: input)
        guard activeResolution.resolvedUID != nil else {
            throw MacRealtimeTalkAudioCaptureError.inputUnavailable
        }

        let format = input.outputFormat(forBus: 0)
        guard format.commonFormat == .pcmFormatFloat32,
              !format.isInterleaved,
              format.channelCount > 0,
              format.sampleRate > 0
        else {
            throw MacRealtimeTalkAudioCaptureError.invalidInputFormat
        }

        let deliveryToken = self.deliveryGate.activate()
        input.installTap(
            onBus: 0,
            bufferSize: Self.frameBufferSize,
            format: format,
            block: MacRealtimeTalkTapHandlerFactory.make(
                targetSampleRate: targetSampleRate,
                deliveryGate: self.deliveryGate,
                deliveryToken: deliveryToken,
                onAudio: onAudio))
        self.tapInstalled = true
        engine.prepare()
        try engine.start()
        self.activeInputResolution = activeResolution
    }

    private func bindSelectedInputIfNeeded(
        _ selection: AudioInputDeviceResolution,
        to input: AVAudioInputNode) -> AudioInputDeviceResolution
    {
        guard selection.shouldBindSelectedDevice, let selectedUID = selection.resolvedUID else {
            return selection
        }
        guard let audioUnit = input.audioUnit,
              var deviceID = AudioInputDeviceObserver.inputDeviceID(forUID: selectedUID)
        else {
            self.logger.warning("realtime selected input could not be resolved; using system default")
            return self.defaultFallback(for: selection)
        }

        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            UInt32(MemoryLayout<AudioObjectID>.size))
        guard status == noErr else {
            self.logger.warning(
                "realtime selected input binding failed status=\(status); using system default")
            return self.defaultFallback(for: selection)
        }
        self.logger.info(
            "realtime selected input bound uid=\(selectedUID, privacy: .private(mask: .hash))")
        return selection
    }

    private func defaultFallback(
        for selection: AudioInputDeviceResolution) -> AudioInputDeviceResolution
    {
        AudioInputDeviceResolution(
            selectedUID: selection.selectedUID,
            resolvedUID: AudioInputDeviceObserver.resolveSelection(nil).resolvedUID,
            fellBackToSystemDefault: selection.selectedUID != nil)
    }

    private func startDeviceObserver() {
        let observer = AudioInputDeviceObserver()
        observer.start { [weak self] in
            Task { @MainActor [weak self] in
                self?.audioInputDevicesDidChange()
            }
        }
        self.audioInputObserver = observer
    }

    private func startOutputRouteObserver() {
        self.updateOutputRoute(MacRealtimeTalkOutputRouteObserver.currentRoute())
        let observer = MacRealtimeTalkOutputRouteObserver()
        observer.start { [weak self] route in
            Task { @MainActor [weak self] in
                self?.updateOutputRoute(route)
            }
        }
        self.audioOutputObserver = observer
    }

    private func updateOutputRoute(_ route: MacRealtimeTalkOutputRoute?) {
        self.suppressInputDuringOutput =
            MacRealtimeTalkOutputRoutePolicy.suppressesInputDuringOutput(for: route)
    }

    private func audioInputDevicesDidChange() {
        guard let targetSampleRate, let onAudio else { return }
        let desiredResolution = AudioInputDeviceObserver.resolveSelection(self.selectedInputUID())
        guard desiredResolution != self.activeInputResolution ||
            self.activeInputResolution?.shouldRestart(
                availableUIDs: AudioInputDeviceObserver.aliveInputDeviceUIDs(),
                defaultUID: AudioInputDeviceObserver.defaultInputDeviceUID()) == true
        else { return }

        self.logger.warning("realtime active/default input changed; restarting capture")
        self.deliveryGate.deactivate()
        self.teardownEngine()
        do {
            try self.startCaptureEngine(targetSampleRate: targetSampleRate, onAudio: onAudio)
        } catch {
            self.logger.error(
                "realtime input restart failed: \(error.localizedDescription, privacy: .public)")
            self.reportFailureOnce(error)
        }
    }

    private func reportFailureOnce(_ error: Error) {
        guard !self.failureReported else { return }
        self.failureReported = true
        self.onFailure(error)
    }

    private func teardownEngine() {
        if self.tapInstalled, let inputNode {
            inputNode.removeTap(onBus: 0)
        }
        self.tapInstalled = false
        self.audioEngine?.stop()
        self.audioEngine = nil
        inputNode = nil
        self.activeInputResolution = nil
    }
}

struct MacRealtimeTalkOutputRoute: Equatable, Sendable {
    let transportType: UInt32
    let terminalTypes: [UInt32]
}

enum MacRealtimeTalkOutputRoutePolicy {
    static func suppressesInputDuringOutput(for route: MacRealtimeTalkOutputRoute?) -> Bool {
        guard let route else { return true }
        return !route.terminalTypes.contains { terminalType in
            switch terminalType {
            case kAudioStreamTerminalTypeLine,
                 kAudioStreamTerminalTypeDigitalAudioInterface,
                 kAudioStreamTerminalTypeHeadphones,
                 kAudioStreamTerminalTypeHDMI,
                 kAudioStreamTerminalTypeDisplayPort:
                true
            default:
                false
            }
        }
    }
}

private struct MacRealtimeTalkAudioPropertyObservation {
    let objectID: AudioObjectID
    let address: AudioObjectPropertyAddress
    let listener: AudioObjectPropertyListenerBlock

    init?(
        objectID: AudioObjectID,
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
        listener: @escaping AudioObjectPropertyListenerBlock)
    {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectAddPropertyListenerBlock(
            objectID,
            &address,
            DispatchQueue.main,
            listener) == noErr
        else { return nil }
        self.objectID = objectID
        self.address = address
        self.listener = listener
    }

    func stop() {
        var address = self.address
        _ = AudioObjectRemovePropertyListenerBlock(
            self.objectID,
            &address,
            DispatchQueue.main,
            self.listener)
    }
}

final class MacRealtimeTalkOutputRouteObserver: @unchecked Sendable {
    private var defaultOutputObservation: MacRealtimeTalkAudioPropertyObservation?
    private var dataSourceObservation: MacRealtimeTalkAudioPropertyObservation?

    static func currentRoute() -> MacRealtimeTalkOutputRoute? {
        guard let deviceID = defaultOutputDeviceID() else { return nil }
        return self.currentRoute(deviceID: deviceID)
    }

    func start(onChange: @escaping @Sendable (MacRealtimeTalkOutputRoute?) -> Void) {
        guard self.defaultOutputObservation == nil else { return }
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.bindCurrentOutput(onChange: onChange)
        }
        guard let observation = MacRealtimeTalkAudioPropertyObservation(
            objectID: AudioObjectID(kAudioObjectSystemObject),
            selector: kAudioHardwarePropertyDefaultOutputDevice,
            scope: kAudioObjectPropertyScopeGlobal,
            listener: listener)
        else {
            onChange(nil)
            return
        }
        self.defaultOutputObservation = observation
        self.bindCurrentOutput(onChange: onChange)
    }

    func stop() {
        self.defaultOutputObservation?.stop()
        self.defaultOutputObservation = nil
        self.dataSourceObservation?.stop()
        self.dataSourceObservation = nil
    }

    private func bindCurrentOutput(
        onChange: @escaping @Sendable (MacRealtimeTalkOutputRoute?) -> Void)
    {
        self.dataSourceObservation?.stop()
        self.dataSourceObservation = nil
        guard let deviceID = Self.defaultOutputDeviceID(),
              let route = Self.currentRoute(deviceID: deviceID)
        else {
            onChange(nil)
            return
        }
        // External outputs often do not expose data-source properties. Built-in
        // output needs this listener because speaker and headphone share a device ID.
        guard route.transportType == kAudioDeviceTransportTypeBuiltIn else {
            onChange(route)
            return
        }
        let listener: AudioObjectPropertyListenerBlock = { _, _ in
            onChange(Self.currentRoute(deviceID: deviceID))
        }
        guard let observation = MacRealtimeTalkAudioPropertyObservation(
            objectID: deviceID,
            selector: kAudioDevicePropertyDataSource,
            scope: kAudioDevicePropertyScopeOutput,
            listener: listener)
        else {
            onChange(nil)
            return
        }
        self.dataSourceObservation = observation
        onChange(route)
    }

    private static func currentRoute(deviceID: AudioObjectID) -> MacRealtimeTalkOutputRoute? {
        guard let transportType = uint32Property(
            objectID: deviceID,
            selector: kAudioDevicePropertyTransportType,
            scope: kAudioObjectPropertyScopeGlobal)
        else { return nil }

        let terminalTypes = self.outputTerminalTypes(deviceID: deviceID)
        guard transportType != kAudioDeviceTransportTypeBuiltIn || !terminalTypes.isEmpty
        else { return nil }
        return MacRealtimeTalkOutputRoute(
            transportType: transportType,
            terminalTypes: terminalTypes)
    }

    private static func defaultOutputDeviceID() -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var deviceID = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &deviceID)
        return status == noErr && deviceID != 0 ? deviceID : nil
    }

    private static func outputTerminalTypes(deviceID: AudioObjectID) -> [UInt32] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size) == noErr,
              size > 0
        else { return [] }

        var streamIDs = [AudioStreamID](
            repeating: 0,
            count: Int(size) / MemoryLayout<AudioStreamID>.size)
        guard AudioObjectGetPropertyData(
            deviceID,
            &address,
            0,
            nil,
            &size,
            &streamIDs) == noErr
        else { return [] }

        return streamIDs.compactMap { streamID in
            self.uint32Property(
                objectID: streamID,
                selector: kAudioStreamPropertyTerminalType,
                scope: kAudioObjectPropertyScopeGlobal)
        }
    }

    private static func uint32Property(
        objectID: AudioObjectID,
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope) -> UInt32?
    {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(
            objectID,
            &address,
            0,
            nil,
            &size,
            &value)
        return status == noErr ? value : nil
    }
}

#if DEBUG
extension MacRealtimeTalkAudioCapture {
    func _test_reportFailure(_ error: Error) {
        self.reportFailureOnce(error)
    }
}
#endif

enum MacRealtimeTalkAudioCaptureError: LocalizedError {
    case invalidTargetSampleRate
    case inputUnavailable
    case invalidInputFormat

    var errorDescription: String? {
        switch self {
        case .invalidTargetSampleRate: "Realtime Talk requested an invalid audio sample rate"
        case .inputUnavailable: "Selected input and system default are unavailable"
        case .invalidInputFormat: "Selected audio input has no usable Float32 format"
        }
    }
}

enum MacRealtimeTalkAudioFrameEncoder {
    nonisolated static func encode(
        buffer: AVAudioPCMBuffer,
        targetSampleRate: Double,
        timestampMs: Double) -> RealtimeTalkAudioFrame?
    {
        let inputSampleRate = buffer.format.sampleRate
        guard targetSampleRate.isFinite, targetSampleRate > 0
        else { return nil }
        let data = RealtimeTalkPCM16Encoder.encode(
            buffer: buffer,
            inputSampleRate: inputSampleRate,
            targetSampleRate: targetSampleRate)
        guard !data.isEmpty else { return nil }
        return RealtimeTalkAudioFrame(
            data: data,
            timestampMs: timestampMs,
            rms: Float(TalkAudioLevel.pcm16RMS(data)))
    }
}

enum MacRealtimeTalkTapHandlerFactory {
    /// AVAudioEngine invokes tap blocks on a realtime audio queue. Build the block from a
    /// nonisolated context so Swift does not inherit MacRealtimeTalkAudioCapture's MainActor
    /// executor and trap when Core Audio calls it off the main thread.
    nonisolated static func make(
        targetSampleRate: Double,
        deliveryGate: MacRealtimeTalkCaptureDeliveryGate,
        deliveryToken: UInt64,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void) -> AVAudioNodeTapBlock
    {
        { buffer, _ in
            guard deliveryGate.isActive(deliveryToken) else { return }
            let frame = MacRealtimeTalkAudioFrameEncoder.encode(
                buffer: buffer,
                targetSampleRate: targetSampleRate,
                timestampMs: ProcessInfo.processInfo.systemUptime * 1000)
            guard let frame else { return }
            deliveryGate.deliver(ifActive: deliveryToken) {
                onAudio(frame)
            }
        }
    }
}

final class MacRealtimeTalkCaptureDeliveryGate: @unchecked Sendable {
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var active = false

    func activate() -> UInt64 {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.generation &+= 1
        self.active = true
        return self.generation
    }

    func deactivate() {
        self.lock.lock()
        self.generation &+= 1
        self.active = false
        self.lock.unlock()
    }

    func isActive(_ generation: UInt64) -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.active && self.generation == generation
    }

    func deliver(ifActive generation: UInt64, _ body: () -> Void) {
        self.lock.lock()
        defer { self.lock.unlock() }
        guard self.active, self.generation == generation else { return }
        body()
    }
}
