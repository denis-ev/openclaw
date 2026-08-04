import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

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
    let paramsJSON: String?
}

private actor RealtimeRelayStartupRequestLog {
    private var requests: [RealtimeRelayStartupRequest] = []

    func record(method: String, paramsJSON: String?) {
        self.requests.append(RealtimeRelayStartupRequest(method: method, paramsJSON: paramsJSON))
    }

    func snapshot() -> [RealtimeRelayStartupRequest] {
        self.requests
    }
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
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { _, _, _ in Data("{\"ok\":true}".utf8) })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: onSpeakingChanged,
            startupTransport: transport)
        session._test_setRelaySessionId("relay-1")
        return session
    }

    @Test func `output playback finish clears barge in start time`() {
        var speakingStates: [Bool] = []
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
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
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "xai", model: nil, voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in },
            startupTransport: transport)
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
            if await !(requests.snapshot()).isEmpty { break }
            await Task.yield()
        }

        let recorded = await requests.snapshot()
        #expect(recorded.count == 1)
        let request = try #require(recorded.first)
        #expect(request.method == "talk.session.acknowledgeMark")
        let paramsData = try #require(request.paramsJSON?.data(using: .utf8))
        let params = try #require(JSONSerialization.jsonObject(with: paramsData) as? [String: String])
        #expect(params == ["sessionId": "relay-1", "markName": "audio-1"])
    }

    @Test func `output cancellation waits for clear and rejects delayed cancelled audio`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                if method == "talk.session.cancelOutput" {
                    await barrier.suspend()
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) },
            startupTransport: transport)
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
        let paramsData = try #require(request.paramsJSON?.data(using: .utf8))
        let params = try #require(JSONSerialization.jsonObject(with: paramsData) as? [String: Any])
        #expect(params["sessionId"] as? String == "relay-1")
        #expect(params["turnId"] as? String == "turn-7")
        #expect(params["outputGeneration"] as? Int == 7)
        #expect(params["reason"] as? String == "barge-in")
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
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })

        session.cancelOutput()
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(generation: 1))

        #expect(speakingStates == [true])
    }

    @Test func `current output cancellation failure terminates and rejects late audio`() async {
        let requests = RealtimeRelayStartupRequestLog()
        var issues: [TalkRuntimeIssue] = []
        var statuses: [String] = []
        var speakingStates: [Bool] = []
        var issueWaiter: CheckedContinuation<Void, Never>?
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                if method == "talk.session.cancelOutput", await requests.snapshot().count == 2 {
                    throw CancellationError()
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onIssue: {
                issues.append($0)
                issueWaiter?.resume()
                issueWaiter = nil
            },
            onSpeakingChanged: { speakingStates.append($0) },
            startupTransport: transport)
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

        #expect(issues.map(\.code) == [.realtimeOutputCancelFailed])
        #expect(issues.map(\.phase) == ["output-cancel"])
        #expect(statuses == issues.map(\.displayMessage))
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
        var issues: [TalkRuntimeIssue] = []
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                if await requests.snapshot().count == 1 {
                    await barrier.suspend()
                    throw CancellationError()
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { speakingStates.append($0) },
            startupTransport: transport)
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
        var issues: [TalkRuntimeIssue] = []
        var statuses: [String] = []
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                if method == "talk.session.cancelOutput" {
                    await barrier.suspend()
                    throw CancellationError()
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in },
            startupTransport: transport)
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
        var issues: [TalkRuntimeIssue] = []
        var statuses: [String] = []
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
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

        #expect(issues.map(\.code) == [.realtimeUnavailable])
        #expect(statuses == ["OpenAI API key rejected with 401"])
    }

    @Test func `closed relay does not wait for startup ready`() async {
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        session.stop()

        #expect(await session._test_waitForStartupCancelled(timeoutSeconds: 1))
    }

    @Test func `startup ready wait covers gateway connect budget`() {
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
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
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in
                await barrier.suspend()
                return AsyncStream { $0.finish() }
            },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                throw URLError(.badServerResponse)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { speakingStates.append($0) },
            startupTransport: transport)
        let start = Task { @MainActor in try await session.start() }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        try await start.value

        #expect(await requests.snapshot().isEmpty)
        #expect(statuses == ["Connecting realtime…"])
        #expect(!speakingStates.contains(true))
    }

    @Test func `stop during relay creation closes late session once`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
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
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                if method == "talk.session.create" {
                    await barrier.suspend()
                    return resultData
                }
                return Data("{}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { speakingStates.append($0) },
            startupTransport: transport)
        let start = Task { @MainActor in try await session.start() }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        try await start.value

        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        let closeJSON = try #require(recorded.last?.paramsJSON?.data(using: .utf8))
        let closeParams = try #require(JSONSerialization.jsonObject(with: closeJSON) as? [String: String])
        #expect(closeParams["sessionId"] == "relay-1")
        #expect(!statuses.contains("Waiting for realtime…"))
        #expect(!speakingStates.contains(true))
    }

    @Test func `stop during buffered tool call prevents late relay side effects`() async {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                if method == "talk.client.toolCall" {
                    await barrier.suspend()
                    return Data("{\"runId\":\"run-1\"}".utf8)
                }
                return Data("{}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { _ in },
            startupTransport: transport)
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

    @Test func `stop cancels buffered microphone audio before dispatch`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in },
            startupTransport: transport)
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        let send = try #require(session._test_enqueueMicrophoneFrame(Data([0x01, 0x02])))

        session.stop()
        await send.value

        #expect(await requests.snapshot().isEmpty)
    }
}
