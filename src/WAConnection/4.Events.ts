import * as QR from 'qrcode-terminal'
import { WAConnection as Base } from './3.Connect'
import { WAMessageStatusUpdate, WAMessage, WAContact, WAChat, WAMessageProto, WA_MESSAGE_STUB_TYPE, WA_MESSAGE_STATUS_TYPE, PresenceUpdate, BaileysEvent, DisconnectReason, WAOpenResult, Presence, AuthenticationCredentials, WAParticipantAction, WAGroupMetadata, WAUser } from './Constants'
import { whatsappID, unixTimestampSeconds, isGroupID, GET_MESSAGE_ID, WA_MESSAGE_ID, waMessageKey, newMessagesDB } from './Utils'
import KeyedDB from '@adiwajshing/keyed-db'
import { Mutex } from './Mutex'

export class WAConnection extends Base {

    constructor () {
        super ()
        // new messages
        this.on('CB:action,add:relay,message', json => {
            const message = json[2][0][2] as WAMessage
            const jid = whatsappID( message.key.remoteJid )
            if (jid.endsWith('@s.whatsapp.net')) {
                const contact = this.contacts[jid]
                if (contact && contact?.lastKnownPresence === Presence.composing) {
                    contact.lastKnownPresence = Presence.available
                }
            }
            this.chatAddMessageAppropriate (message)
        })
        this.on('CB:Chat,cmd:action', json => {
            const data = json[1].data
            if (data) {
                const emitGroupParticipantsUpdate = (action: WAParticipantAction) => this.emit(
                    'group-participants-update', 
                    { participants: data[2].participants.map(whatsappID), actor: data[1], jid: json[1].id, action }
                )
                switch (data[0]) {
                    case "promote":
                        emitGroupParticipantsUpdate('promote')
                        break
                    case "demote":
                        emitGroupParticipantsUpdate('demote')
                        break
                }
            }
        })
        // presence updates
        this.on('CB:Presence', json => {
            const update = json[1] as PresenceUpdate
            const jid = whatsappID(update.participant || update.id)
            
            const contact = this.contacts[jid]
            if (contact && jid.endsWith('@s.whatsapp.net')) { // if its a single chat
                if (update.t) contact.lastSeen = +update.t
                else if (update.type === Presence.unavailable && contact.lastKnownPresence !== Presence.unavailable) {
                    contact.lastSeen = unixTimestampSeconds()
                }
                contact.lastKnownPresence = update.type
            }

            this.emit('user-presence-update', update)
        })
        // If a message has been updated (usually called when a video message gets its upload url, or live locations)
        this.on ('CB:action,add:update,message', json => {
            const message: WAMessage = json[2][0][2]
            const jid = whatsappID(message.key.remoteJid)
            const chat = this.chats.get(jid)
            if (!chat) return
            // reinsert to update
            const oldMessage = chat.messages.get (WA_MESSAGE_ID(message))
            if (oldMessage) {
                message['epoch'] = oldMessage['epoch']
                chat.messages.delete (oldMessage)
                chat.messages.insert (message)

                const chatUpdate: Partial<WAChat> = { jid, messages: newMessagesDB([ message ]) }
                this.emit ('chat-update', chatUpdate)
                // emit deprecated
                this.emit ('message-update', message)
            } else {
                this.logger.debug ({ unhandled: true }, 'received message update for non-present message from ' + jid)
            }
        })
        // If a user's contact has changed
        this.on ('CB:action,,user', json => {
            const node = json[2][0]
            if (node) {
                const user = node[1] as WAContact
                user.jid = whatsappID(user.jid)
                
                this.contacts[user.jid] = user
                
                const chat = this.chats.get (user.jid)
                if (chat) {
                    chat.name = user.name || user.notify || chat.name
                    this.emit ('chat-update', { jid: chat.jid, name: chat.name })
                }
            }
        })
        // chat archive, pin etc.
        this.on('CB:action,,chat', json => {
            json = json[2][0]

            const updateType = json[1].type
            const jid = whatsappID(json[1]?.jid)
            
            const chat = this.chats.get(jid)
            if (!chat) return

            const FUNCTIONS = {
                'delete': () => {
                    chat['delete'] = 'true'
                    this.chats.delete(chat)
                    return 'delete'
                },
                'clear': () => {
                    if (!json[2]) chat.messages.clear ()
                    else json[2].forEach(item => chat.messages.filter(m => m.key.id !== item[1].index))
                    return 'clear'
                },
                'archive': () => {
                    chat.archive = 'true'
                    return 'archive'
                },
                'unarchive': () => {
                    delete chat.archive
                    return 'archive'
                },
                'pin': () => {
                    chat.pin = json[1].pin
                    return 'pin'
                }
            }
            const func = FUNCTIONS [updateType]
            
            if (func) {
                const property = func ()
                this.emit ('chat-update', { jid, [property]: chat[property] || null })
            }            
        })
        // profile picture updates
        this.on('CB:Cmd,type:picture', async json => {
            const jid = whatsappID(json[1].jid)
            const chat = this.chats.get(jid)
            if (!chat) return
            
            await this.setProfilePicture (chat)
            this.emit ('chat-update', { jid, imgUrl: chat.imgUrl })
        })
        // status updates
        this.on('CB:Status', async json => {
            const jid = whatsappID(json[1].id)
            this.emit ('user-status-update', { jid, status: json[1].status })
        })
        // read updates
        this.on ('CB:action,,read', async json => {
            const update = json[2][0][1]
            const jid = whatsappID(update.jid)
            const chat = this.chats.get (jid) || await this.chatAdd (jid)

            if (update.type === 'false') chat.count = -1
            else chat.count = 0

            this.emit ('chat-update', { jid: chat.jid, count: chat.count })
        })
        this.on ('CB:action,add:relay,received', json => {
            json = json[2][0][1]
            if (json.type === 'error') {
                const update: WAMessageStatusUpdate = {
                    from: this.user.jid,
                    to: whatsappID(json.jid),
                    participant: this.user.jid,
                    timestamp: new Date(),
                    ids: [ json.index ],
                    type: WA_MESSAGE_STATUS_TYPE.ERROR,
                }
                this.forwardStatusUpdate (update)
            }
        })

        const func = json => {
            json = json[1]
            let ids = json.id
            
            if (json.cmd === 'ack') ids = [json.id]
            
            const update: WAMessageStatusUpdate = {
                from: whatsappID(json.from),
                to: whatsappID(json.to),
                participant: whatsappID(json.participant),
                timestamp: new Date(json.t * 1000),
                ids: ids,
                type: (+json.ack)+1,
            }
            this.forwardStatusUpdate (update)
        }
        this.on('CB:Msg', func)
        this.on('CB:MsgInfo', func)
        
        this.on ('qr', qr => QR.generate(qr, { small: true }))
    }
    /** Get the URL to download the profile picture of a person/group */
    @Mutex (jid => jid)
    async getProfilePicture(jid: string | null) {
        const response = await this.query({ json: ['query', 'ProfilePicThumb', jid || this.user.jid], expect200: true, requiresPhoneConnection: false })
        return response.eurl as string
    }
    protected forwardStatusUpdate (update: WAMessageStatusUpdate) {
        const chat = this.chats.get( whatsappID(update.to) )
        if (!chat) return
        
        this.emit ('message-status-update', update) 
        this.chatUpdatedMessage (update.ids, update.type, chat)
    }
    /** inserts an empty chat into the DB */
    protected async chatAdd (jid: string, name?: string) {
        if (this.chats.get (jid)) return
        
        const chat: WAChat = {
            jid: jid,
            t: unixTimestampSeconds(),
            messages: new KeyedDB(waMessageKey, WA_MESSAGE_ID),
            count: 0,
            modify_tag: '',
            spam: 'false',
            name
        }
        this.chats.insert (chat)
        if (this.loadProfilePicturesForChatsAutomatically) {
            await this.setProfilePicture (chat)
        }
        this.emit ('chat-new', chat)

        return chat
    }
    /** find a chat or return an error */
    protected assertChatGet = jid => {
        const chat = this.chats.get (jid)
        if (!chat) throw new Error (`chat '${jid}' not found`)
        return chat
    }
    /** Adds the given message to the appropriate chat, if the chat doesn't exist, it is created */
    protected async chatAddMessageAppropriate (message: WAMessage) {
        const jid = whatsappID (message.key.remoteJid)
        const chat = this.chats.get(jid) || await this.chatAdd (jid)
        this.chatAddMessage (message, chat)
    }
    protected chatAddMessage (message: WAMessage, chat: WAChat) {
        // store updates in this
        const chatUpdate: Partial<WAChat> & { jid: string } = { jid: chat.jid }
        
        // add to count if the message isn't from me & there exists a message
        if (!message.key.fromMe && message.message) {
            chat.count += 1
            chatUpdate.count = chat.count
            const contact = this.contacts[message.participant || chat.jid]
            if (contact && contact.lastKnownPresence === Presence.composing) { // update presence
                contact.lastKnownPresence = Presence.available // emit change
                this.emit ('user-presence-update', { id: chat.jid, presence: Presence.available, participant: message.participant })
            }
        }

        const messages = chat.messages
        const protocolMessage = message.message?.protocolMessage
        // if it's a message to delete another message
        if (protocolMessage) {
            switch (protocolMessage.type) {
                case WAMessageProto.ProtocolMessage.PROTOCOL_MESSAGE_TYPE.REVOKE:
                    const found = chat.messages.get (GET_MESSAGE_ID(protocolMessage.key))
                    if (found?.message) {
                        this.logger.info ('deleting message: ' + protocolMessage.key.id + ' in chat: ' + protocolMessage.key.remoteJid)
                        
                        found.messageStubType = WA_MESSAGE_STUB_TYPE.REVOKE
                        delete found.message
                        chatUpdate.messages = newMessagesDB([ found ])
                        // emit deprecated
                        this.emit('message-update', found)
                    }
                    break
                default:
                    break
            }
        } else if (!messages.get(WA_MESSAGE_ID(message))) { // if the message is not already there

            const last = messages.all().slice(-1)
            const lastEpoch = ((last && last[0]) && last[0]['epoch']) || 0
            message['epoch'] = lastEpoch+1

            messages.insert (message)

            while (messages.length > this.maxCachedMessages) {
                messages.delete (messages.all()[0]) // delete oldest messages
            }            
            // only update if it's an actual message
            if (message.message) {
                this.chatUpdateTime (chat)
                chatUpdate.t = chat.t
            }
            chatUpdate.messages = newMessagesDB([ message ])
            // emit deprecated
            this.emit('message-new', message)

            // check if the message is an action 
            if (message.messageStubType) {
                const jid = chat.jid
                let actor = whatsappID (message.participant)
                let participants: string[]
                const emitParticipantsUpdate = (action: WAParticipantAction) => this.emit ('group-participants-update', { jid, actor, participants, action })
                const emitGroupUpdate = (update: Partial<WAGroupMetadata>) => this.emit ('group-update', { jid, actor, ...update })
                
                switch (message.messageStubType) {
                    case WA_MESSAGE_STUB_TYPE.GROUP_PARTICIPANT_LEAVE:
                    case WA_MESSAGE_STUB_TYPE.GROUP_PARTICIPANT_REMOVE:
                        participants = message.messageStubParameters.map (whatsappID)
                        emitParticipantsUpdate('remove')
                        // mark the chat read only if you left the group
                        if (participants.includes(this.user.jid)) {
                            chat.read_only = 'true'
                            chatUpdate.read_only = 'true'
                        }
                        break
                    case WA_MESSAGE_STUB_TYPE.GROUP_PARTICIPANT_ADD:
                    case WA_MESSAGE_STUB_TYPE.GROUP_PARTICIPANT_INVITE:
                    case WA_MESSAGE_STUB_TYPE.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
                        participants = message.messageStubParameters.map (whatsappID)
                        if (participants.includes(this.user.jid) && chat.read_only === 'true') {
                            delete chat.read_only
                            chatUpdate.read_only = 'false'
                        }
                        emitParticipantsUpdate('add')
                        break
                    case WA_MESSAGE_STUB_TYPE.GROUP_CHANGE_ANNOUNCE:
                        const announce = message.messageStubParameters[0] === 'on' ? 'true' : 'false'
                        emitGroupUpdate({ announce })
                        break
                    case WA_MESSAGE_STUB_TYPE.GROUP_CHANGE_ANNOUNCE:
                        const restrict = message.messageStubParameters[0] === 'on' ? 'true' : 'false'
                        emitGroupUpdate({ restrict })
                        break
                    case WA_MESSAGE_STUB_TYPE.GROUP_CHANGE_DESCRIPTION:
                        const desc = message.messageStubParameters[0]
                        emitGroupUpdate({ desc })
                        break
                    case WA_MESSAGE_STUB_TYPE.GROUP_CHANGE_SUBJECT:
                    case WA_MESSAGE_STUB_TYPE.GROUP_CREATE:
                        chat.name = message.messageStubParameters[0]
                        chatUpdate.name = chat.name
                        break
                }
            }
        }

        this.emit('chat-update', chatUpdate)
    }
    protected chatUpdatedMessage (messageIDs: string[], status: WA_MESSAGE_STATUS_TYPE, chat: WAChat) {
        for (let id of messageIDs) {
            let msg = chat.messages.get (GET_MESSAGE_ID({ id, fromMe: true })) || chat.messages.get (GET_MESSAGE_ID({ id, fromMe: false }))
            if (msg && msg.status < status) {
                if (status <= WA_MESSAGE_STATUS_TYPE.PENDING) msg.status = status
                else if (isGroupID(chat.jid)) msg.status = status-1
                else msg.status = status
            }
        }
    }
    protected chatUpdateTime = chat => this.chats.updateKey (chat, c => c.t = unixTimestampSeconds())
    /** sets the profile picture of a chat */
    protected async setProfilePicture (chat: WAChat) {
        chat.imgUrl = await this.getProfilePicture (chat.jid).catch (err => '')
    }

    // Add all event types

    /** when the connection has opened successfully */
    on (event: 'open', listener: (result: WAOpenResult) => void): this
    /** when the connection is opening */
    on (event: 'connecting', listener: () => void): this
    /** when the connection has been validated */
    on (event: 'connection-validated', listener: (user: WAUser) => void): this
    /** when the connection has closed */
    on (event: 'close', listener: (err: {reason?: DisconnectReason | string, isReconnecting: boolean}) => void): this
    /** when the socket is closed */
    on (event: 'ws-close', listener: (err: {reason?: DisconnectReason | string}) => void): this
    /** when WA updates the credentials */
    on (event: 'credentials-updated', listener: (auth: AuthenticationCredentials) => void): this
    /** when a new QR is generated, ready for scanning */
    on (event: 'qr', listener: (qr: string) => void): this
    /** when the connection to the phone changes */
    on (event: 'connection-phone-change', listener: (state: {connected: boolean}) => void): this
    /** when a user's presence is updated */
    on (event: 'user-presence-update', listener: (update: PresenceUpdate) => void): this
    /** when a user's status is updated */
    on (event: 'user-status-update', listener: (update: {jid: string, status?: string}) => void): this
    /** when a new chat is added */
    on (event: 'chat-new', listener: (chat: WAChat) => void): this
    /** when a chat is updated (new message, updated message, deleted, pinned, etc) */
    on (event: 'chat-update', listener: (chat: Partial<WAChat> & { jid: string }) => void): this
    /** 
     * when a new message is relayed 
     * @deprecated use `chat-update`
     * */
    on (event: 'message-new', listener: (message: WAMessage) => void): this
    /** 
     * when a message object itself is updated (receives its media info or is deleted) 
     * @deprecated use `chat-update`
     * */
    on (event: 'message-update', listener: (message: WAMessage) => void): this
    /** when a message's status is updated (deleted, delivered, read, sent etc.) */
    on (event: 'message-status-update', listener: (message: WAMessageStatusUpdate) => void): this
    /** when participants are added to a group */
    on (event: 'group-participants-update', listener: (update: {jid: string, participants: string[], actor?: string, action: WAParticipantAction}) => void): this
    /** when the group is updated */
    on (event: 'group-update', listener: (update: Partial<WAGroupMetadata> & {jid: string, actor?: string}) => void): this
    /** when WA sends back a pong */
    on (event: 'received-pong', listener: () => void): this

    on (event: string, listener: (json: any) => void): this

    on (event: BaileysEvent | string, listener: (...args: any[]) => void) { return super.on (event, listener) }
    emit (event: BaileysEvent | string, ...args: any[]) { return super.emit (event, ...args) }
}
