import Foundation

#if DEBUG
/// Sample answers for the local test session, so every screen can be looked at with realistic content.
/// Debug builds only, and only for the "Continue as Test User" session; nothing here touches an account.
enum PreviewData {
    static var isActive: Bool { (KeychainHelper.shared.read(key: "session_token") ?? "").isEmpty }

    static func response(path: String, method: String) -> Data? {
        guard isActive, method == "GET" else { return nil }
        let clean = path.components(separatedBy: "?").first ?? path
        let json: String?
        switch clean {
        case let p where p.hasPrefix("/history/"): json = history
        case let p where p.hasPrefix("/connectors/apps"): json = apps
        case let p where p.hasPrefix("/connectors/"): json = connectors
        case "/agent/activity": json = activity
        case "/agent/home-feed": json = homeFeed
        case "/agent/context": json = context
        case let p where p.hasPrefix("/memory/") && p.hasSuffix("/items"): json = memory
        default: json = nil
        }
        return json?.data(using: .utf8)
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
          {"id":"h7","role":"assistant","content":"Tomorrow is light: dentist at 10, then nothing until the 8:12 train on Friday.","created_at":"\(iso(5))"}
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
      {"id":"c4","verb":"Add","rest":"the Sunday Market on Sunday 26 October, 11am to your calendar?","prompt":"Add the Sunday Market to my calendar.","brand":"google"}
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
