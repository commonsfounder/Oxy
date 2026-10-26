import Foundation

#if DEBUG
/// Sample answers for the local test session, so every screen can be looked at with realistic content.
/// Debug builds only, and only for the "Continue as Test User" session; nothing here touches an account.
enum PreviewData {
    static var isIsolated: Bool { ProcessInfo.processInfo.environment["OXY_DEBUG_AUTOLOGIN"] == "1" }
    static var isActive: Bool { isIsolated || (KeychainHelper.shared.read(key: "session_token") ?? "").isEmpty }

    static func response(path: String, method: String) -> Data? {
        guard isActive, method == "GET" else { return nil }
        let clean = path.components(separatedBy: "?").first ?? path
        let state = ProcessInfo.processInfo.environment["OXY_DEBUG_STATE"]
        if state == "failure" { return Data("{invalid fixture".utf8) }
        if (state == "own-failure" && clean.hasPrefix("/connectors/") && clean != "/connectors/apps")
            || (state == "catalogue-failure" && clean == "/connectors/apps")
            || (state == "permissions-failure" && clean == "/vault/grants") {
            return Data("{invalid fixture".utf8)
        }
        if state == "empty" {
            if clean.hasPrefix("/connectors/"), clean != "/connectors/apps", clean != "/connectors/agent-card", clean != "/connectors/stripe/card",
               let data = connectors.data(using: .utf8),
               var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let entries = object["connectors"] as? [[String: Any]] {
                object["connectors"] = entries.map { entry in
                    var value = entry
                    value["enabled"] = false
                    value["connectionState"] = "available"
                    return value
                }
                return try? JSONSerialization.data(withJSONObject: object)
            }
            let empty: String?
            switch clean {
            case "/connectors/apps": empty = #"{"configured":true,"connections":[]}"#
            case let p where p.hasPrefix("/history/"): empty = #"{"history":[]}"#
            case "/agent/state": empty = #"{"needsYou":[],"handling":[],"changed":[],"completed":[],"counts":{"needsYou":0,"handling":0,"changed":0,"completed":0}}"#
            case "/agent/home-feed": empty = #"{"cards":[]}"#
            case "/agent/activity": empty = #"{"events":[],"asks":[],"upcoming":[]}"#
            case let p where p.hasPrefix("/memory/") && p.hasSuffix("/items"): empty = #"{"items":[]}"#
            default: empty = nil
            }
            if let empty { return Data(empty.utf8) }
        }
        let json: String?
        switch clean {
        case let p where p.hasPrefix("/history/"): json = history
        case "/connectors/agent-card":
            json = state == "empty" ? #"{"card":null}"# : #"{"card":{"brand":"visa","last4":"4242","expMonth":12,"expYear":2028,"name":"Sample cardholder"}}"#
        case "/connectors/stripe/card": json = #"{"card":null}"#
        case "/concierge/balance": json = #"{"balance":null}"#
        case "/vault/credentials":
            json = state == "empty" ? #"{"credentials":[]}"# : #"{"credentials":[{"id":"sample-login","site":"johnlewis.com","label":"John Lewis","username":"alex@example.com","updated_at":"2026-10-23T10:00:00Z"}]}"#
        case "/vault/grants":
            json = state == "empty" ? #"{"grants":[]}"# : """
            {"grants":[
              {"id":"sample-permission","site":"johnlewis.com","scope":"standing","expires_at":"\(iso(-10080))","max_uses":5,"use_count":1},
              {"id":"sample-expired","site":"tesco.com","scope":"standing","expires_at":"\(iso(1440))","use_count":2}
            ]}
            """
        case "/vault/credential-uses":
            json = state == "empty" ? #"{"uses":[]}"# : """
            {"uses":[
              {"id":"sample-use","site":"johnlewis.com","outcome":"used","created_at":"\(iso(30))"},
              {"id":"sample-denial","site":"example.com","outcome":"denied","reason":"no_grant","created_at":"\(iso(60))"}
            ]}
            """
        case "/agent/displays":
            json = state == "empty" ? #"{"displays":[]}"# : """
            {"displays":[
              {"id":"sample-kitchen","name":"Kitchen","type":"browser","capabilities":{"render":true},"lastSeenAt":"\(iso(0.5))"},
              {"id":"sample-study","name":"Study","type":"browser","capabilities":{"render":true},"lastSeenAt":"\(iso(180))"}
            ]}
            """
        case "/agent/continuity":
            json = state == "empty" ? #"{"imports":[],"supportedSources":["chatgpt","claude"]}"# : """
            {"imports":[
              {"id":"sample-import","source":"chatgpt","status":"completed","conversation_count":12,"message_count":56,"project_count":1,"document_count":2,"memory_count":3},
              {"id":"sample-import-failed","source":"claude","status":"failed","conversation_count":0,"message_count":0,"project_count":0,"document_count":0,"memory_count":0}
            ],"supportedSources":["chatgpt","claude"]}
            """
        case "/agent/home":
            json = #"{"presence":{"state":"unknown","homeConfigured":false},"devices":[],"rooms":[],"unassignedDevices":[],"watches":[],"observations":[]}"#
        case let p where p.hasPrefix("/connectors/apps"): json = apps
        case let p where p.hasPrefix("/connectors/"): json = connectors
        case "/agent/activity": json = activity
        case "/agent/state": json = #"{"needsYou":[],"handling":[],"changed":[],"completed":[],"counts":{"needsYou":0,"handling":0,"changed":0,"completed":0}}"#
        case "/agent/home-feed": json = homeFeed
        case "/agent/context": json = context
        case let p where p.hasPrefix("/memory/") && p.hasSuffix("/items"): json = memory
        default: json = nil
        }
        return json?.data(using: .utf8)
    }

    static func threadMessages(for flow: String) -> [Message]? {
        let request = Message(role: .user, content: "Add the 8:12 train to Manchester to my calendar, with a reminder the night before.", timestamp: Date().addingTimeInterval(-120))
        switch flow {
        case "outcome":
            let action = ActionResult(action: "create_calendar_event", success: true,
                text: "Friday, 23 October · 08:12–09:44. Birmingham New Street to Manchester Piccadilly. Reminder: Thursday at 20:00.",
                actionSummary: "Added the train to your calendar")
            return [request, Message(role: .assistant, content: "The train is in your calendar. Your reminder is set for the night before. The ticket still needs booking.", actions: [action])]
        case "failure":
            return [request, Message(role: .assistant, content: "", turnError: "Calendar didn't respond. The event hasn't been added.")]
        case "streaming":
            return [request, Message(role: .assistant, content: "The 8:12 service leaves Birmingham New Street and arrives at Manchester Piccadilly at 9:44. I'm checking", isStreaming: true)]
        case "multiple-failures":
            return [request, Message(role: .assistant, content: "", turnError: "Calendar didn't respond. The event hasn't been added."),
                Message(role: .user, content: "Find the parcel tracking email", timestamp: Date().addingTimeInterval(-30)),
                Message(role: .assistant, content: "", turnError: "Email didn't respond. No tracking details were found.")]
        case "delayed":
            return [Message(role: .user, content: request.content, timestamp: Date().addingTimeInterval(-26 * 60 * 60)),
                Message(role: .assistant, content: "The calendar is available again. The train is now in your calendar.")]
        case "dense":
            return [request, Message(role: .assistant, content: "The train is in your calendar."),
                Message(role: .user, content: "Find the parcel tracking email", timestamp: Date().addingTimeInterval(-60)),
                Message(role: .assistant, content: "The email says delivery is expected this afternoon."),
                Message(role: .user, content: "What's on my calendar tomorrow?", timestamp: Date().addingTimeInterval(-30)),
                Message(role: .assistant, content: "Tomorrow: dentist at 10.")]
        case "long-history":
            return (0..<60).flatMap { index in
                let date = Date().addingTimeInterval(Double(index - 60) * 120)
                return [Message(role: .user, content: "Sample request \(index + 1): Find the parcel tracking email", timestamp: date),
                        Message(role: .assistant, content: "Sample result \(index + 1): Delivery is expected this afternoon.", timestamp: date.addingTimeInterval(30))]
            }
        case "results":
            let ask = Message(role: .user, content: "Find me a good kettle under £60.", timestamp: Date().addingTimeInterval(-90))
            let options = [
                ResultOption(id: "0:a", title: "Bosch Sky Kettle 1.7L", subtitle: "Variable temperature, keep warm", price: "£49", priceAmount: 49, rating: 4.6, ratingCount: 812, imageUrl: nil, url: "https://www.johnlewis.com", source: "John Lewis", note: nil),
                ResultOption(id: "1:b", title: "Russell Hobbs Stainless Kettle", subtitle: "3kW rapid boil", price: "£34", priceAmount: 34, rating: 4.3, ratingCount: 2210, imageUrl: nil, url: "https://www.argos.co.uk", source: "Argos", note: "Delivery in 5 days"),
                ResultOption(id: "2:c", title: "Smeg Retro Kettle", subtitle: nil, price: "£59", priceAmount: 59, rating: 4.8, ratingCount: 304, imageUrl: nil, url: "https://www.amazon.co.uk", source: "Amazon", note: nil)
            ]
            let action = ActionResult(action: "show_results", success: true, outcome: "completed", text: "Showing 3 options", results: options)
            return [ask, Message(role: .assistant, content: "Three kettles under £60. The Russell Hobbs is cheapest; the Smeg is the best rated.", actions: [action])]
        case "working":
            return [request]
        default: return nil
        }
    }

    private static func iso(_ minutesAgo: Double) -> String {
        ISO8601DateFormatter().string(from: Date().addingTimeInterval(-minutesAgo * 60))
    }

    private static var history: String {
        """
        {"history":[
          {"id":"h1","role":"user","content":"Can you find me a train to Manchester on Friday morning?","created_at":"\(iso(1500))"},
          {"id":"h2","role":"assistant","content":"The 8:12 from Birmingham New Street gets you in at 9:44, and it's the cheapest at £23. Want me to put it in your calendar?","created_at":"\(iso(1499))"},
          {"id":"h3","role":"user","content":"yes","created_at":"\(iso(1497))"},
          {"id":"h4","role":"assistant","content":"Done. It's in your calendar and I'll remind you the night before. I haven't booked the ticket.","created_at":"\(iso(1496))"},
          {"id":"h5","role":"assistant","content":"Alisa's birthday is in 3 days. Want a hand with a message or a gift?","created_at":"\(iso(40))","offer":{"id":"occasion:alisa:birthday:2026","yes":"Yes please","prompt":"Help me with Alisa's birthday."}},
          {"id":"h6","role":"user","content":"what's on my calendar tomorrow","created_at":"\(iso(6))"},
          {"id":"h7","role":"assistant","content":"Tomorrow: dentist at 10.","created_at":"\(iso(5))"}
        ]}
        """
    }

    private static let connectors = """
    {"connectors":[
      {"id":"google","name":"Gmail & Calendar","icon":"google","category":"Productivity","enabled":true,"implemented":true,"connectionState":"connected","statusText":"Connected","kind":"connection"},
      {"id":"telegram","name":"Telegram","icon":"telegram","category":"Messages","enabled":true,"implemented":true,"connectionState":"connected","statusText":"Connected","kind":"connection"},
      {"id":"microsoft","name":"Outlook & Calendar","icon":"outlook","category":"Productivity","enabled":false,"implemented":true,"connectionState":"available","statusText":"Available","kind":"connection"},
      {"id":"notion","name":"Notion","icon":"notion","category":"Productivity","enabled":false,"implemented":true,"connectionState":"available","statusText":"Available","kind":"connection"},
      {"id":"strava","name":"Strava","icon":"strava","category":"Health","enabled":false,"implemented":true,"connectionState":"available","statusText":"Available","kind":"connection"},
      {"id":"oura","name":"Oura","icon":"oura","category":"Health","enabled":false,"implemented":true,"connectionState":"available","statusText":"Available","kind":"connection"},
      {"id":"slack","name":"Slack","icon":"slack","category":"Work","enabled":false,"implemented":true,"connectionState":"available","statusText":"Available","kind":"connection"}
    ]}
    """

    private static let apps = """
    {"configured":true,"connections":[
      {"id":"a","toolkit":"googlephotos","status":"ACTIVE","connected":true},
      {"id":"b","toolkit":"todoist","status":"ACTIVE","connected":true}
    ]}
    """

    private static let homeFeed = """
    {"cards":[
      {"id":"c1","verb":"Send","rest":"the tenancy documents? Due tomorrow","prompt":"Help me finish this: send the tenancy documents.","brand":null},
      {"id":"c2","verb":"Remind","rest":"me to top up Monzo by £13.71 tonight? It's over its overdraft limit","prompt":"Remind me to top up Monzo tonight.","brand":"monzo"},
      {"id":"c3","verb":"Plan","rest":"something for Alisa's birthday in 3 days?","prompt":"Help with Alisa's birthday.","brand":null},
      {"id":"c4","verb":"Add","rest":"the Sunday Market on Sunday 25 October, 11am to your calendar?","prompt":"Add the Sunday Market to my calendar.","brand":"google"}
    ]}
    """

    private static var activity: String {
        """
        {"events":[
          {"id":"e1","type":"did","title":"Added the 8:12 train to your calendar","detail":"Friday morning, with a reminder the night before","at":"\(iso(1496))"},
          {"id":"e2","type":"checked","title":"Looked at flight prices to Istanbul","detail":"Cheapest is £164 on 14 Nov","at":"\(iso(300))"},
          {"id":"e3","type":"noticed","title":"A parcel is out for delivery","detail":"Due this afternoon","at":"\(iso(120))"},
          {"id":"e4","type":"did","title":"Couldn't open the parcel tracking page","detail":"It didn't load. I'll try again later","at":"\(iso(7))","failed":true}
        ],"asks":[
          {"id":"a1","type":"asked","title":"Pay the £84 council bill?","detail":"Due 3 Nov","at":"\(iso(90))","open":true}
        ],"upcoming":[
          {"id":"u1","type":"scheduled","title":"Flight price check","detail":"Every Friday morning","at":"\(iso(-2000))"}
        ]}
        """
    }

    private static var context: String {
        guard let data = try? JSONEncoder().encode(AgentContextDemo.snapshot), let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    private static var memory: String {
        """
        {"items":[
          {"id":"m1","content":"Based in Birmingham","source":"fact","created_at":"\(iso(9000))"},
          {"id":"m2","content":"Prefers direct, short answers","source":"fact","created_at":"\(iso(7000))"},
          {"id":"m3","content":"Usual station is Birmingham New Street","source":"fact","created_at":"\(iso(5000))"},
          {"id":"m4","content":"Photo from 2026-10-15: a red two-piece set, one person in the room","source":"photos","created_at":"\(iso(3000))"}
        ]}
        """
    }
}
#endif
