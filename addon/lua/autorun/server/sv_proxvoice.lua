-- ProxVoice: sends player positions, facing, alive state and wall occlusion to the
-- ProxVoice server, and handles "!voice CODE" to link a browser to a Steam account.
if not SERVER then return end

CreateConVar("proxvoice_url", "http://127.0.0.1:8090", FCVAR_ARCHIVE, "ProxVoice server URL as seen from this GMod server")
CreateConVar("proxvoice_secret", "", FCVAR_ARCHIVE + FCVAR_PROTECTED, "Shared secret; must match BRIDGE_SECRET on the ProxVoice server")
CreateConVar("proxvoice_public_url", "", FCVAR_ARCHIVE, "Address players open in their browser (shown in chat on join)")
CreateConVar("proxvoice_hz", "10", FCVAR_ARCHIVE, "State updates per second (5-20)")
CreateConVar("proxvoice_occlusion", "1", FCVAR_ARCHIVE, "Muffle voices when a wall is between two players")
CreateConVar("proxvoice_occlusion_range", "1600", FCVAR_ARCHIVE, "Only trace walls between players closer than this (match the server's far distance)")

local function cv(name) return GetConVar(name) end

local function post(body, onDone)
    local url = string.TrimRight(cv("proxvoice_url"):GetString(), "/") .. "/events"
    HTTP({
        url = url,
        method = "POST",
        body = util.TableToJSON(body),
        type = "application/json",
        headers = { ["x-bridge-secret"] = cv("proxvoice_secret"):GetString() },
        success = function(code, data) if onDone then onDone(code, data) end end,
        failed = function(err) if onDone then onDone(nil, nil, err) end end,
    })
end

-- ---------- round state ----------
local roundActive = false
hook.Add("TTTBeginRound", "ProxVoice_Begin", function() roundActive = true end)
hook.Add("TTTEndRound", "ProxVoice_End", function() roundActive = false end)
hook.Add("TTTPrepareRound", "ProxVoice_Prep", function() roundActive = false end)

local function isAlive(ply)
    if ply.IsTerror then return ply:IsTerror() end -- TTT: excludes spectators
    return ply:Alive()
end

-- ---------- periodic state snapshot ----------
local inFlight, inFlightSince = false, 0
local nextSend = 0

hook.Add("Think", "ProxVoice_State", function()
    local now = RealTime()
    if inFlight and now - inFlightSince > 3 then inFlight = false end -- request hung; don't stall forever
    if now < nextSend or inFlight then return end
    nextSend = now + 1 / math.Clamp(cv("proxvoice_hz"):GetFloat(), 5, 20)

    local list, alive = {}, {}
    for _, ply in ipairs(player.GetHumans()) do
        if IsValid(ply) and ply:IsFullyAuthenticated() then
            local pos, ang = ply:GetPos(), ply:EyeAngles()
            local a = isAlive(ply)
            list[#list + 1] = {
                steamid64 = ply:SteamID64(), name = ply:Nick(),
                x = math.Round(pos.x), y = math.Round(pos.y), z = math.Round(pos.z),
                yaw = math.Round(ang.y, 1), alive = a,
            }
            if a then alive[#alive + 1] = ply end
        end
    end
    if #list == 0 then return end

    -- Wall occlusion between living players in earshot (world geometry only, props don't count)
    local walls = {}
    if cv("proxvoice_occlusion"):GetBool() then
        local range2 = cv("proxvoice_occlusion_range"):GetFloat() ^ 2
        for i = 1, #alive do
            local a = alive[i]
            local ea = a:EyePos()
            for j = i + 1, #alive do
                local b = alive[j]
                local eb = b:EyePos()
                if ea:DistToSqr(eb) <= range2 then
                    local tr = util.TraceLine({ start = ea, endpos = eb, mask = MASK_SOLID_BRUSHONLY })
                    if tr.Hit then walls[#walls + 1] = { a:SteamID64(), b:SteamID64() } end
                end
            end
        end
    end

    inFlight, inFlightSince = true, now
    post({ type = "state", round = roundActive, players = list, walls = walls }, function() inFlight = false end)
end)

-- ---------- linking ----------
hook.Add("PlayerSay", "ProxVoice_Link", function(ply, text)
    local code = string.match(string.Trim(text or ""), "^[!/]voice%s+(%w+)$")
    if not code then return end
    code = string.upper(code)
    post({ type = "voice_link", code = code, player = { steamid64 = ply:SteamID64(), name = ply:Nick() } }, function(status, data, err)
        if not IsValid(ply) then return end
        if not status then ply:ChatPrint("[ProxVoice] Can't reach the voice server: " .. tostring(err)) return end
        if status == 401 then ply:ChatPrint("[ProxVoice] Server secret mismatch; tell an admin.") return end
        local resp = util.JSONToTable(data or "") or {}
        if resp.linked then
            ply:ChatPrint("[ProxVoice] Linked! Your browser is now in proximity voice.")
        elseif resp.reason == "code_expired" then
            ply:ChatPrint("[ProxVoice] That code expired. Click 'Get a new code' in the browser.")
        else
            ply:ChatPrint("[ProxVoice] Code not found. Check the code shown in your browser.")
        end
    end)
    return "" -- hide the code from chat
end)

hook.Add("PlayerInitialSpawn", "ProxVoice_Hint", function(ply)
    local url = cv("proxvoice_public_url"):GetString()
    if url == "" then return end
    timer.Simple(8, function()
        if IsValid(ply) then ply:ChatPrint("[ProxVoice] Proximity voice: open " .. url .. " and type !voice CODE here.") end
    end)
end)

print("[ProxVoice] loaded")
