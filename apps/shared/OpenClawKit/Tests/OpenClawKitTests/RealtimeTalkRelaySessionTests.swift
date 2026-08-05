import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

@MainActor
private final class UnusedPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    func play(stream: AsyncThrowingStream<Data, Error>, sampleRate: Double) async -> StreamingPlaybackResult {
        fatalError("Playback is not used by this test")
    }

    func stop() -> Double? {
        nil
    }
}

@MainActor
private final class DrainingPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    func play(stream: AsyncThrowingStream<Data, Error>, sampleRate _: Double) async -> StreamingPlaybackResult {
        do {
            for try await _ in stream {}
        } catch {}
        return StreamingPlaybackResult(finished: true, interruptedAt: nil)
    }

    func stop() -> Double? {
        nil
    }
}

@MainActor
private final class TestRealtimeTalkAudioCapture: RealtimeTalkAudioCapturing {
    var suppressesInputDuringOutput = false
    private(set) var isStarted = false
    private(set) var startCount = 0
    private(set) var stopCount = 0
    private let startError: Error?

    init(startError: Error? = nil) {
        self.startError = startError
    }

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void) throws
    {
        self.startCount += 1
        if let startError {
            throw startError
        }
        self.isStarted = true
    }

    func stop() {
        self.isStarted = false
        self.stopCount += 1
    }
}

private actor RealtimeRelayStartupBarrier {
    private var entered = false
    private var enteredWaiter: CheckedContinuation<Void, Never>?
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func suspend() async {
        self.entered = true
        self.enteredWaiter?.resume()
        self.enteredWaiter = nil
        await withCheckedContinuation { self.releaseWaiter = $0 }
    }

    func waitUntilEntered() async {
        if self.entered {
            return
        }
        await withCheckedContinuation { self.enteredWaiter = $0 }
    }

    func release() {
        self.releaseWaiter?.resume()
        self.releaseWaiter = nil
    }
}

private struct RealtimeRelayStartupRequest: Sendable {
    let method: String
    let params: [String: AnyCodable]?
}

private actor RealtimeRelayStartupRequestLog {
    private var requests: [RealtimeRelayStartupRequest] = []

    func record(method: String, params: [String: AnyCodable]?) {
        self.requests.append(RealtimeRelayStartupRequest(method: method, params: params))
    }

    func snapshot() -> [RealtimeRelayStartupRequest] {
        self.requests
    }
}

private actor RealtimeRelayEventSource {
    private var continuation: AsyncStream<EventFrame>.Continuation?

    func stream() -> AsyncStream<EventFrame> {
        AsyncStream { self.continuation = $0 }
    }

    func yield(_ event: EventFrame) {
        self.continuation?.yield(event)
    }

    func finish() {
        self.continuation?.finish()
    }
}

private func unusedRealtimeRelayTransport() -> RealtimeTalkRelayTransport {
    RealtimeTalkRelayTransport(
        subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
        request: { _, _, _ in throw CancellationError() })
}

private func outputAudioEvent(generation: Int) -> EventFrame {
    EventFrame(
        type: "event",
        event: "talk.event",
        payload: AnyCodable([
            "relaySessionId": "relay-1",
            "type": "audio",
            "audioBase64": Data([0x01]).base64EncodedString(),
            "outputGeneration": generation,
        ]),
        seq: nil,
        stateversion: nil)
}

@MainActor
struct RealtimeTalkRelaySessionTests {
    enum CancellationRetirement {
        case clear
        case close
    }

    private func makeIdleCancellationSession(
        _ onSpeakingChanged: @escaping (Bool) -> Void) -> RealtimeTalkRelaySession
    {
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { _, _, _ in Data("{\"ok\":true}".utf8) })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: onSpeakingChanged)
        session._test_setRelaySessionId("relay-1")
        return session
    }

    private func makeAudioSendSession() -> (RealtimeTalkRelaySession, RealtimeRelayStartupRequestLog) {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        return (session, requests)
    }

    @Test func `transcript callback carries typed partial and final values`() async {
        var transcripts: [RealtimeTalkTranscript] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in },
            onTranscript: { transcripts.append($0) })
        session._test_setRelaySessionId("relay-1")

        for isFinal in [false, true] {
            await session._test_handleGatewayEvent(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "transcript",
                    "role": "user",
                    "text": isFinal ? "hello" : "hel",
                    "final": isFinal,
                ]),
                seq: nil,
                stateversion: nil))
        }

        #expect(transcripts == [
            RealtimeTalkTranscript(role: "user", text: "hel", isFinal: false),
            RealtimeTalkTranscript(role: "user", text: "hello", isFinal: true),
        ])
    }

    @Test func `input pause and resume are idempotent and keep relay alive`() throws {
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        try session.setInputPaused(true)
        try session.setInputPaused(true)
        try session.setInputPaused(false)
        try session.setInputPaused(false)

        #expect(audioCapture.stopCount == 2)
        #expect(audioCapture.startCount == 1)
        #expect(audioCapture.isStarted)
    }

    @Test func `input resume surfaces capture restart failure`() throws {
        let audioCapture = TestRealtimeTalkAudioCapture(startError: URLError(.cannotOpenFile))
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        try session.setInputPaused(true)
        do {
            try session.setInputPaused(false)
            Issue.record("expected audio capture restart failure")
        } catch {
            #expect((error as? URLError)?.code == .cannotOpenFile)
        }

        #expect(audioCapture.startCount == 1)
        #expect(!audioCapture.isStarted)
    }

    @Test func `output playback finish clears barge in start time`() {
        var speakingStates: [Bool] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })

        session._test_markOutputAudioStarted(nowMs: 100)
        #expect(session._test_isOutputPlaying())
        #expect(session._test_outputStartedAtMs() == 100)

        session._test_markOutputPlaybackFinished()
        #expect(!session._test_isOutputPlaying())
        #expect(session._test_outputStartedAtMs() == nil)
        #expect(speakingStates == [false])

        session._test_markOutputAudioStarted(nowMs: 500)
        #expect(session._test_outputStartedAtMs() == 500)
    }

    @Test func `playback mark is acknowledged after output finishes`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "xai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        session._test_markOutputAudioStarted(nowMs: 100)

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "mark",
                "markName": "audio-1",
            ]),
            seq: nil,
            stateversion: nil))
        await Task.yield()
        #expect(await requests.snapshot().isEmpty)

        session._test_markOutputPlaybackFinished()
        for _ in 0..<10 {
            let snapshot = await requests.snapshot()
            if !snapshot.isEmpty { break }
            await Task.yield()
        }

        let recorded = await requests.snapshot()
        #expect(recorded.count == 1)
        let request = try #require(recorded.first)
        #expect(request.method == "talk.session.acknowledgeMark")
        #expect(request.params?["sessionId"]?.stringValue == "relay-1")
        #expect(request.params?["markName"]?.stringValue == "audio-1")
    }

    @Test func `output cancellation waits for clear and rejects delayed cancelled audio`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.cancelOutput" {
                    await barrier.suspend()
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x01, 0x02]).base64EncodedString(),
                "outputGeneration": 7,
                "talkEvent": ["turnId": "turn-7"],
            ]),
            seq: nil,
            stateversion: nil))
        session.cancelOutput(reason: "barge-in")
        await barrier.waitUntilEntered()

        let request = try #require(await requests.snapshot().first)
        #expect(request.method == "talk.session.cancelOutput")
        #expect(request.params?["sessionId"]?.stringValue == "relay-1")
        #expect(request.params?["turnId"]?.stringValue == "turn-7")
        #expect(request.params?["outputGeneration"]?.doubleValue == 7)
        #expect(request.params?["reason"]?.stringValue == "barge-in")
        await barrier.release()

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x03, 0x04]).base64EncodedString(),
                "outputGeneration": 7,
                "talkEvent": ["turnId": "turn-7"],
            ]),
            seq: nil,
            stateversion: nil))
        #expect(speakingStates == [true, false])

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x05, 0x06]).base64EncodedString(),
                "outputGeneration": 8,
                "talkEvent": ["turnId": "turn-8"],
            ]),
            seq: nil,
            stateversion: nil))
        #expect(speakingStates == [true, false])

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "clear",
                "outputGeneration": 7,
            ]),
            seq: nil,
            stateversion: nil))
        #expect(speakingStates == [true, false])

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x07, 0x08]).base64EncodedString(),
                "outputGeneration": 7,
                "talkEvent": ["turnId": "turn-7"],
            ]),
            seq: nil,
            stateversion: nil))
        #expect(speakingStates == [true, false])

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x09, 0x0A]).base64EncodedString(),
                "outputGeneration": 8,
                "talkEvent": ["turnId": "turn-8"],
            ]),
            seq: nil,
            stateversion: nil))
        #expect(speakingStates == [true, false, true])

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x0B, 0x0C]).base64EncodedString(),
                "outputGeneration": 7,
                "talkEvent": ["turnId": "turn-7"],
            ]),
            seq: nil,
            stateversion: nil))
        #expect(speakingStates == [true, false, true])

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "clear",
                "outputGeneration": 8,
            ]),
            seq: nil,
            stateversion: nil))
        #expect(speakingStates == [true, false, true, false])
    }

    @Test func `idle output cancellation blocks audio until relay clear`() async {
        var speakingStates: [Bool] = []
        let session = self.makeIdleCancellationSession { speakingStates.append($0) }

        session.cancelOutput(reason: "barge-in")
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x01]).base64EncodedString(),
                "outputGeneration": 1,
            ]),
            seq: nil,
            stateversion: nil))

        #expect(speakingStates == [false])
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "clear",
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x01]).base64EncodedString(),
                "outputGeneration": 1,
            ]),
            seq: nil,
            stateversion: nil))

        #expect(speakingStates == [false, true])
    }

    @Test func `output cancellation without a relay leaves playback unfenced`() async {
        var speakingStates: [Bool] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })

        session.cancelOutput()
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(generation: 1))

        #expect(speakingStates == [true])
    }

    @Test func `output pause blocks replacement audio until resumed`() async {
        var speakingStates: [Bool] = []
        let session = self.makeIdleCancellationSession { speakingStates.append($0) }
        let audio: (Int) -> EventFrame = { generation in
            EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "audio",
                    "audioBase64": Data([0x01]).base64EncodedString(),
                    "outputGeneration": generation,
                ]),
                seq: nil,
                stateversion: nil)
        }

        await session._test_handleGatewayEvent(audio(1))
        session.setOutputPaused(true)
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "clear",
                "outputGeneration": 1,
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleGatewayEvent(audio(2))
        #expect(speakingStates == [true, false])

        session.setOutputPaused(false)
        await session._test_handleGatewayEvent(audio(2))

        #expect(speakingStates == [true, false, true])
    }

    @Test func `current output cancellation failure terminates and rejects late audio`() async {
        let requests = RealtimeRelayStartupRequestLog()
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        var statuses: [String] = []
        var speakingStates: [Bool] = []
        var issueWaiter: CheckedContinuation<Void, Never>?
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.cancelOutput", await requests.snapshot().count == 2 {
                    throw CancellationError()
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onIssue: {
                issues.append($0)
                issueWaiter?.resume()
                issueWaiter = nil
            },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(generation: 1))
        session.cancelOutput()
        for _ in 0..<10 {
            if await requests.snapshot().count == 1 { break }
            await Task.yield()
        }
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "clear",
                "outputGeneration": 1,
            ]),
            seq: nil,
            stateversion: nil))
        speakingStates.removeAll()

        await withCheckedContinuation { continuation in
            issueWaiter = continuation
            session.cancelOutput()
        }
        await session._test_handleGatewayEvent(outputAudioEvent(generation: 1))
        await session._test_handleGatewayEvent(outputAudioEvent(generation: 2))
        session.stop()
        for _ in 0..<10 {
            if await requests.snapshot().contains(where: { $0.method == "talk.session.close" }) { break }
            await Task.yield()
        }

        #expect(issues.map(\.code) == ["realtime_output_cancel_failed"])
        #expect(issues.map(\.phase) == ["output-cancel"])
        #expect(terminations == [.outputCancellationFailed])
        #expect(statuses == issues.map(\.message))
        #expect(await requests.snapshot().map(\.method) == [
            "talk.session.cancelOutput",
            "talk.session.cancelOutput",
            "talk.session.close",
        ])
        #expect(!speakingStates.contains(true))
    }

    @Test func `superseded output cancellation failure leaves the active fence intact`() async {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var issues: [RealtimeTalkRelayIssue] = []
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if await requests.snapshot().count == 1 {
                    await barrier.suspend()
                    throw CancellationError()
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")

        session.cancelOutput()
        await barrier.waitUntilEntered()
        session.cancelOutput()
        await barrier.release()
        for _ in 0..<10 {
            if await requests.snapshot().count == 2 { break }
            await Task.yield()
        }
        await session._test_handleGatewayEvent(outputAudioEvent(generation: 1))

        #expect(issues.isEmpty)
        #expect(await requests.snapshot().count == 2)
        #expect(!speakingStates.contains(true))
    }

    @Test(arguments: [CancellationRetirement.clear, .close])
    func `clear and close invalidate in flight output cancellation failures`(
        retirement: CancellationRetirement) async
    {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var issues: [RealtimeTalkRelayIssue] = []
        var statuses: [String] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.cancelOutput" {
                    await barrier.suspend()
                    throw CancellationError()
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        session.cancelOutput()
        await barrier.waitUntilEntered()
        switch retirement {
        case .clear:
            await session._test_handleGatewayEvent(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "clear",
                ]),
                seq: nil,
                stateversion: nil))
        case .close:
            session.stop()
        }
        await barrier.release()
        await Task.yield()

        #expect(issues.isEmpty)
        #expect(statuses.isEmpty)
    }

    @Test func `close after classified error does not replace issue`() async {
        var issues: [RealtimeTalkRelayIssue] = []
        var statuses: [String] = []
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "error",
                "message": "OpenAI API key rejected with 401",
                "code": "realtime_unavailable",
                "provider": "openai",
                "model": "gpt-realtime-2",
                "transport": "gateway-relay",
                "phase": "connect",
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "close",
                "reason": "error",
            ]),
            seq: nil,
            stateversion: nil))

        #expect(issues.map(\.code) == ["realtime_unavailable"])
        #expect(statuses == ["OpenAI API key rejected with 401"])
    }

    @Test func `ready then close publishes one typed termination and releases capture`() async {
        var statuses: [String] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "ready",
            ]),
            seq: nil,
            stateversion: nil))
        let closeEvent = EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "close",
                "reason": "completed",
            ]),
            seq: nil,
            stateversion: nil)
        await session._test_handleGatewayEvent(closeEvent)
        await session._test_handleGatewayEvent(closeEvent)

        #expect(statuses == ["Listening (Realtime)", "Ready"])
        #expect(terminations == [.remoteClose(reason: "completed")])
        #expect(audioCapture.stopCount == 1)
    }

    @Test func `ready then event stream end publishes typed termination`() async {
        var terminations: [RealtimeTalkRelayTermination] = []
        let audioCapture = TestRealtimeTalkAudioCapture()
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onTermination: { terminations.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "ready",
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleEventStreamEnded()
        await session._test_handleEventStreamEnded()

        #expect(terminations == [.eventStreamEnded])
        #expect(audioCapture.stopCount == 1)
    }

    @Test func `event stream ending before ready fails startup and closes relay once`() async throws {
        let events = RealtimeRelayEventSource()
        let requests = RealtimeRelayStartupRequestLog()
        let audioCapture = TestRealtimeTalkAudioCapture()
        var issues: [RealtimeTalkRelayIssue] = []
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in await events.stream() },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return method == "talk.session.create"
                    ? resultData
                    : Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        let start = Task { @MainActor in
            do {
                try await session.start()
                return nil as String?
            } catch {
                return error.localizedDescription
            }
        }
        while !audioCapture.isStarted {
            await Task.yield()
        }

        await events.finish()
        let failure = await start.value
        while await requests.snapshot().filter({ $0.method == "talk.session.close" }).isEmpty {
            await Task.yield()
        }

        #expect(failure == "Realtime event stream ended before it became ready.")
        #expect(issues == [RealtimeTalkRelayIssue(
            message: "Realtime event stream ended before it became ready.",
            provider: "openai",
            model: "gpt-realtime-2",
            transport: "gateway-relay",
            phase: "connect")])
        #expect(audioCapture.stopCount == 2)
        #expect(!audioCapture.isStarted)
        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
    }

    @Test func `event stream ending during relay creation closes late relay and fails startup`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let events = RealtimeRelayEventSource()
        let requests = RealtimeRelayStartupRequestLog()
        let audioCapture = TestRealtimeTalkAudioCapture()
        var issues: [RealtimeTalkRelayIssue] = []
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in await events.stream() },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.create" {
                    await barrier.suspend()
                    return resultData
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        let start = Task { @MainActor in
            do {
                try await session.start()
                return nil as String?
            } catch {
                return error.localizedDescription
            }
        }
        await barrier.waitUntilEntered()

        await events.finish()
        while issues.isEmpty {
            await Task.yield()
        }
        await barrier.release()
        let failure = await start.value

        #expect(failure == "Realtime event stream ended before it became ready.")
        #expect(issues.count == 1)
        #expect(audioCapture.startCount == 0)
        #expect(audioCapture.stopCount == 1)
        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
    }

    @Test func `closed relay does not wait for startup ready`() async {
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        session.stop()

        #expect(await session._test_waitForStartupCancelled(timeoutSeconds: 1))
    }

    @Test func `pre ready failure remains a failed start after relay closes`() async throws {
        let events = RealtimeRelayEventSource()
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in await events.stream() },
            request: { method, _, _ in
                guard method == "talk.session.create" else {
                    return Data("{\"ok\":true}".utf8)
                }
                await events.yield(EventFrame(
                    type: "event",
                    event: "talk.event",
                    payload: AnyCodable([
                        "relaySessionId": "relay-1",
                        "type": "error",
                        "message": "Realtime auth failed",
                    ]),
                    seq: nil,
                    stateversion: nil))
                await events.yield(EventFrame(
                    type: "event",
                    event: "talk.event",
                    payload: AnyCodable([
                        "relaySessionId": "relay-1",
                        "type": "close",
                        "reason": "error",
                    ]),
                    seq: nil,
                    stateversion: nil))
                await Task.yield()
                return resultData
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        do {
            try await session.start()
            Issue.record("expected pre-ready relay failure")
        } catch {
            #expect(error.localizedDescription == "Realtime auth failed")
        }
    }

    @Test func `startup ready wait covers gateway connect budget`() {
        let session = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        #expect(session._test_startupReadyTimeoutSeconds() >= 12)
    }

    @Test func `stop during event subscription prevents relay creation`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in
                await barrier.suspend()
                return AsyncStream { $0.finish() }
            },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                throw URLError(.badServerResponse)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        let start = Task { @MainActor in try await session.start() }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        try await start.value

        #expect(await requests.snapshot().isEmpty)
        #expect(statuses == ["Connecting realtime…"])
        #expect(!speakingStates.contains(true))
    }

    @Test func `stale transport after event subscription fails startup`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                throw URLError(.badServerResponse)
            },
            isCurrent: { false })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        do {
            try await session.start()
            Issue.record("expected stale transport failure")
        } catch {
            #expect(error.localizedDescription == "Gateway connection changed while starting realtime.")
        }

        #expect(await requests.snapshot().isEmpty)
    }

    @Test func `stale transport after relay creation closes late session and fails startup`() async throws {
        let events = RealtimeRelayEventSource()
        let requests = RealtimeRelayStartupRequestLog()
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in await events.stream() },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.create" {
                    return resultData
                }
                return Data("{\"ok\":true}".utf8)
            },
            isCurrent: {
                await requests.snapshot().isEmpty
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        do {
            try await session.start()
            Issue.record("expected stale transport failure")
        } catch {
            #expect(error.localizedDescription == "Gateway connection changed while starting realtime.")
        }

        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
    }

    @Test func `stop during relay creation closes late session once`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let events = RealtimeRelayEventSource()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        var speakingStates: [Bool] = []
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in await events.stream() },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.create" {
                    await barrier.suspend()
                    return resultData
                }
                return Data("{}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        let start = Task { @MainActor in try await session.start() }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        try await start.value

        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        #expect(recorded.last?.params?["sessionId"]?.stringValue == "relay-1")
        #expect(!statuses.contains("Waiting for realtime…"))
        #expect(!speakingStates.contains(true))
    }

    @Test func `stop during buffered tool call prevents late relay side effects`() async {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.client.toolCall" {
                    await barrier.suspend()
                    return Data("{\"runId\":\"run-1\"}".utf8)
                }
                return Data("{}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        let handling = Task { @MainActor in
            await session._test_handleGatewayEvent(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "toolCall",
                    "callId": "call-1",
                    "name": "lookup",
                    "args": [:],
                ]),
                seq: nil,
                stateversion: nil))
        }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        await handling.value
        await session._test_waitForToolCalls()

        let methods = await requests.snapshot().map(\.method)
        #expect(methods.first == "talk.client.toolCall")
        #expect(!methods.contains("talk.session.submitToolResult"))
        #expect(statuses == ["Thinking…"])
    }

    @Test func `stop and pause discard buffered microphone audio before dispatch`() async throws {
        let (stoppedSession, stoppedRequests) = self.makeAudioSendSession()
        let stoppedSend = try #require(stoppedSession._test_enqueueMicrophoneFrame(Data([0x01])))

        stoppedSession.stop()
        await stoppedSend.value
        #expect(await stoppedRequests.snapshot().isEmpty)

        let (session, requests) = self.makeAudioSendSession()
        _ = try #require(session._test_enqueueMicrophoneFrame(Data([0x01])))
        try session.setInputPaused(true)
        try session.setInputPaused(false)
        try await (#require(session._test_enqueueMicrophoneFrame(Data([0x02])))).value

        #expect(await requests.snapshot().compactMap { $0.params?["audioBase64"]?.stringValue } == [Data([0x02])
                .base64EncodedString()])
    }
}
