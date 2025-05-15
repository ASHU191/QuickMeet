"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Phone,
  PhoneOff,
  Copy,
  Video,
  VideoOff,
  Mic,
  MicOff,
  RefreshCw,
  Shield,
  AlertCircle,
  Camera,
} from "lucide-react"

// Free public TURN servers - in production, you should use your own TURN server
const PUBLIC_TURN_SERVERS = [
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
]

// Call states to manage the call lifecycle more strictly
type CallState =
  | "idle" // No call in progress
  | "connecting" // Call is being established
  | "connected" // Call is active
  | "disconnecting" // Call is being terminated
  | "failed" // Call failed to connect

export default function VideoCall() {
  const [myPeerId, setMyPeerId] = useState<string>("")
  const [remotePeerId, setRemotePeerId] = useState<string>("")
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const [callState, setCallState] = useState<CallState>("idle")
  const [videoEnabled, setVideoEnabled] = useState<boolean>(true)
  const [audioEnabled, setAudioEnabled] = useState<boolean>(true)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [peerDestroyed, setPeerDestroyed] = useState<boolean>(false)
  const [isReconnecting, setIsReconnecting] = useState<boolean>(false)
  const [callButtonDisabled, setCallButtonDisabled] = useState<boolean>(false)
  const [usingTurnServer, setUsingTurnServer] = useState<boolean>(false)
  const [iceConnectionState, setIceConnectionState] = useState<string>("new")
  const [connectionTimeout, setConnectionTimeout] = useState<number>(0)
  const [debugInfo, setDebugInfo] = useState<string[]>([])
  const [showDebug, setShowDebug] = useState<boolean>(false)
  const [remoteStreamReceived, setRemoteStreamReceived] = useState<boolean>(false)
  const [remoteVideoTracks, setRemoteVideoTracks] = useState<number>(0)
  const [remoteAudioTracks, setRemoteAudioTracks] = useState<number>(0)
  const [remoteStreamActive, setRemoteStreamActive] = useState<boolean>(false)

  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const peerRef = useRef<any>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const connectionRef = useRef<any>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const callCooldownRef = useRef<NodeJS.Timeout | null>(null)
  const rtcConnectionRef = useRef<RTCPeerConnection | null>(null)
  const callLockRef = useRef<boolean>(false) // Lock to prevent concurrent call operations
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const remoteStreamCheckRef = useRef<NodeJS.Timeout | null>(null)

  // Helper function to add debug info
  const addDebugInfo = (info: string) => {
    console.log(info)
    setDebugInfo((prev) => [...prev.slice(-19), `${new Date().toLocaleTimeString()}: ${info}`])
  }

  // Function to check remote video element status
  const checkRemoteVideoStatus = () => {
    if (remoteVideoRef.current && remoteStreamRef.current) {
      const videoElement = remoteVideoRef.current
      const stream = remoteStreamRef.current

      // Check if the video element has the stream
      const hasStream = videoElement.srcObject === stream

      // Check stream and track status
      const videoTracks = stream.getVideoTracks()
      const audioTracks = stream.getAudioTracks()

      setRemoteVideoTracks(videoTracks.length)
      setRemoteAudioTracks(audioTracks.length)

      // Check if video tracks are enabled and active
      const videoActive =
        videoTracks.length > 0 && videoTracks.some((track) => track.enabled && track.readyState === "live")

      // Check if the video element is actually playing
      const isPlaying = !videoElement.paused && videoElement.currentTime > 0 && !videoElement.ended

      setRemoteStreamActive(videoActive && isPlaying)

      addDebugInfo(
        `Remote video status: ${hasStream ? "Has stream" : "No stream"}, ` +
          `Video tracks: ${videoTracks.length}, Audio tracks: ${audioTracks.length}, ` +
          `Video active: ${videoActive}, Playing: ${isPlaying}`,
      )

      // If we have a stream but it's not playing, try to play it
      if (hasStream && videoTracks.length > 0 && !isPlaying) {
        videoElement.play().catch((err) => {
          addDebugInfo(`Error playing remote video: ${err}`)
        })
      }
    }
  }

  // Initialize PeerJS and get local media stream
  useEffect(() => {
    let mounted = true

    const initPeer = async () => {
      try {
        // Clear any existing reconnection timeouts
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current)
          reconnectTimeoutRef.current = null
        }

        // Reset state
        setPeerDestroyed(false)
        setIsReconnecting(false)
        setUsingTurnServer(false)
        setIceConnectionState("new")
        setCallState("idle")
        callLockRef.current = false
        setDebugInfo([])
        setRemoteStreamReceived(false)
        setRemoteVideoTracks(0)
        setRemoteAudioTracks(0)
        setRemoteStreamActive(false)
        addDebugInfo("Initializing peer connection...")

        // Import PeerJS dynamically (since it's a client-side only library)
        const { default: Peer } = await import("peerjs")

        let stream: MediaStream | null = null

        try {
          // Try to get user media
          addDebugInfo("Requesting camera and microphone access...")
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
          })
          addDebugInfo("Camera and microphone access granted")
        } catch (mediaError) {
          console.warn("Camera/mic access error:", mediaError)
          addDebugInfo(`Media error: ${mediaError}`)
          setMediaError("Camera and microphone not available. Trying audio only...")

          // Try audio only as fallback
          try {
            addDebugInfo("Trying audio-only mode...")
            stream = await navigator.mediaDevices.getUserMedia({
              video: false,
              audio: true,
            })
            setVideoEnabled(false)
            setMediaError("Camera not available. Using audio-only mode.")
            addDebugInfo("Audio-only mode activated")
          } catch (audioError) {
            console.warn("Audio-only access error:", audioError)
            addDebugInfo(`Audio error: ${audioError}`)
            setMediaError("No camera or microphone detected. You can still receive calls but won't send audio/video.")

            // Create empty stream as last resort
            stream = new MediaStream()
            setVideoEnabled(false)
            setAudioEnabled(false)
            addDebugInfo("No media devices available, using empty stream")
          }
        }

        // Save the stream reference
        localStreamRef.current = stream

        // Display local video if we have video tracks
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream

          // Check if local video is playing
          const videoTracks = stream.getVideoTracks()
          if (videoTracks.length > 0) {
            addDebugInfo(`Local video tracks: ${videoTracks.length}, enabled: ${videoTracks[0].enabled}`)
            localVideoRef.current.play().catch((err) => {
              addDebugInfo(`Error playing local video: ${err}`)
            })
          }
        }

        // Create new peer with enhanced ICE server configuration
        const peerOptions = {
          debug: 1, // Reduce debug level to minimize console noise
          config: {
            iceServers: [
              // STUN servers - help with NAT traversal
              { urls: "stun:stun.l.google.com:19302" },
              { urls: "stun:stun1.l.google.com:19302" },
              { urls: "stun:stun2.l.google.com:19302" },
              { urls: "stun:stun3.l.google.com:19302" },
              { urls: "stun:stun4.l.google.com:19302" },
              // TURN servers - relay traffic when direct connection fails
              ...PUBLIC_TURN_SERVERS,
            ],
            sdpSemantics: "unified-plan",
            // These settings help with firewall traversal
            iceTransportPolicy: "all", // Try both relay and direct connections
            rtcpMuxPolicy: "require",
            bundlePolicy: "max-bundle",
            // Increase ICE candidate gathering timeout
            iceCandidatePoolSize: 10,
          },
        }

        // Destroy any existing peer before creating a new one
        if (peerRef.current) {
          try {
            addDebugInfo("Destroying existing peer connection")
            peerRef.current.destroy()
          } catch (err) {
            console.error("Error destroying existing peer:", err)
            addDebugInfo(`Error destroying peer: ${err}`)
          }
          peerRef.current = null
        }

        // Create a new peer with a random ID
        addDebugInfo("Creating new PeerJS instance")
        const peer = new Peer(undefined, peerOptions)
        peerRef.current = peer

        // When peer is open (connected to the signaling server)
        peer.on("open", (id) => {
          if (!mounted) return
          addDebugInfo(`Connected to signaling server with ID: ${id}`)
          setMyPeerId(id)
          setIsConnected(true)
          setMediaError(null)
        })

        // Handle incoming calls with strict state management
        peer.on("call", (call) => {
          if (!mounted) return

          addDebugInfo("Incoming call received")

          // If we're already handling a call operation, reject this one
          if (callLockRef.current) {
            addDebugInfo("Call operation in progress, rejecting incoming call")
            try {
              call.close()
            } catch (err) {
              console.error("Error closing conflicting call:", err)
              addDebugInfo(`Error closing conflicting call: ${err}`)
            }
            return
          }

          // Set the call lock
          callLockRef.current = true

          // If we're already in a call, close it first
          if (connectionRef.current) {
            addDebugInfo("Ending existing call before answering new one")
            try {
              // Update state first to avoid race conditions
              setCallState("disconnecting")

              // Close the existing connection
              connectionRef.current.close()
              connectionRef.current = null

              // Clear remote video
              if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = null
              }
              remoteStreamRef.current = null
              setRemoteStreamReceived(false)
              setRemoteVideoTracks(0)
              setRemoteAudioTracks(0)
              setRemoteStreamActive(false)
            } catch (err) {
              console.error("Error closing existing call:", err)
              addDebugInfo(`Error closing existing call: ${err}`)
            }
          }

          // Wait to ensure clean state before answering
          addDebugInfo("Waiting before answering call...")
          setTimeout(() => {
            if (!mounted) {
              callLockRef.current = false
              return
            }

            try {
              addDebugInfo("Answering incoming call")
              setCallState("connecting")

              // Answer the call with our stream
              call.answer(localStreamRef.current)

              // Set up event handlers for the call
              call.on("stream", (remoteStream) => {
                if (!mounted) return
                addDebugInfo("Received remote stream")

                // Store the remote stream reference
                remoteStreamRef.current = remoteStream
                setRemoteStreamReceived(true)

                // Check remote stream tracks
                const videoTracks = remoteStream.getVideoTracks()
                const audioTracks = remoteStream.getAudioTracks()
                setRemoteVideoTracks(videoTracks.length)
                setRemoteAudioTracks(audioTracks.length)

                addDebugInfo(
                  `Remote stream has ${videoTracks.length} video tracks and ${audioTracks.length} audio tracks`,
                )

                if (videoTracks.length === 0) {
                  addDebugInfo("Warning: Remote stream has no video tracks")
                }

                // Assign the stream to the video element
                if (remoteVideoRef.current) {
                  remoteVideoRef.current.srcObject = remoteStream

                  // Try to play the video
                  remoteVideoRef.current
                    .play()
                    .then(() => {
                      addDebugInfo("Remote video playback started successfully")
                      setRemoteStreamActive(true)
                    })
                    .catch((err) => {
                      addDebugInfo(`Error playing remote video: ${err}`)
                    })
                } else {
                  addDebugInfo("Error: Remote video element not available")
                }

                setCallState("connected")

                // Start periodic checks of remote video status
                if (remoteStreamCheckRef.current) {
                  clearInterval(remoteStreamCheckRef.current)
                }

                remoteStreamCheckRef.current = setInterval(() => {
                  if (mounted) checkRemoteVideoStatus()
                }, 5000) // Check every 5 seconds
              })

              // Handle call close
              call.on("close", () => {
                if (!mounted) return
                addDebugInfo("Call closed")

                setCallState("idle")

                // Clear remote video
                if (remoteVideoRef.current) {
                  remoteVideoRef.current.srcObject = null
                }
                remoteStreamRef.current = null
                setRemoteStreamReceived(false)
                setRemoteVideoTracks(0)
                setRemoteAudioTracks(0)
                setRemoteStreamActive(false)

                // Stop remote video checks
                if (remoteStreamCheckRef.current) {
                  clearInterval(remoteStreamCheckRef.current)
                  remoteStreamCheckRef.current = null
                }

                // Release the call lock
                callLockRef.current = false
              })

              // Handle call errors
              call.on("error", (err) => {
                if (!mounted) return
                console.error("Call error:", err)
                addDebugInfo(`Call error: ${err}`)

                setMediaError(`Call error: ${err}`)
                setCallState("failed")

                // Clear remote video
                if (remoteVideoRef.current) {
                  remoteVideoRef.current.srcObject = null
                }
                remoteStreamRef.current = null
                setRemoteStreamReceived(false)
                setRemoteVideoTracks(0)
                setRemoteAudioTracks(0)
                setRemoteStreamActive(false)

                // Stop remote video checks
                if (remoteStreamCheckRef.current) {
                  clearInterval(remoteStreamCheckRef.current)
                  remoteStreamCheckRef.current = null
                }

                // Release the call lock after a delay
                setTimeout(() => {
                  callLockRef.current = false
                  setCallState("idle")
                }, 1000)
              })

              // Store the call reference
              connectionRef.current = call

              // Access the underlying RTCPeerConnection to monitor ICE connection state
              // @ts-ignore - accessing internal PeerJS property
              const pc = call.peerConnection
              if (pc) {
                rtcConnectionRef.current = pc

                // Monitor ICE connection state
                pc.addEventListener("iceconnectionstatechange", () => {
                  if (!mounted) return

                  const state = pc.iceConnectionState
                  addDebugInfo(`ICE connection state changed: ${state}`)
                  setIceConnectionState(state)

                  // Check if we're using a TURN server when connected
                  if (state === "connected" || state === "completed") {
                    checkIfUsingTurnServer(pc)
                  }

                  // Handle failed connections
                  if (state === "failed") {
                    setMediaError("WebRTC connection failed. The app is trying to use a relay server.")
                    setCallState("failed")

                    // Release the call lock after a delay
                    setTimeout(() => {
                      if (connectionRef.current === call) {
                        endCall()
                      }
                      callLockRef.current = false
                    }, 1000)
                  }
                })
              }
            } catch (err) {
              console.error("Error answering call:", err)
              addDebugInfo(`Error answering call: ${err}`)
              setMediaError(`Error answering call: ${err.message || "Unknown error"}`)

              // Release the call lock
              callLockRef.current = false
              setCallState("idle")
            }
          }, 1000) // Longer delay to ensure clean state
        })

        // Handle errors with more specific feedback
        peer.on("error", (err) => {
          if (!mounted) return
          console.error("Peer error:", err)
          addDebugInfo(`Peer error: ${err.type}`)

          // Provide more specific error messages based on error type
          if (err.type === "peer-unavailable") {
            setMediaError(`Peer ID "${remotePeerId}" not found. Check the ID and try again.`)
          } else if (err.type === "disconnected") {
            setMediaError("Connection to signaling server lost.")
          } else if (err.type === "network" || err.type === "server-error") {
            setMediaError("Network or server error. Please check your connection and try again.")
          } else if (err.type === "webrtc") {
            setMediaError(
              "WebRTC connection failed. The app will try to use relay servers instead of direct connection.",
            )

            // For WebRTC errors, we should end any ongoing call and reset connection state
            if (callState !== "idle") {
              endCall()
            }

            // Add a cooldown period before allowing another call attempt
            setCallButtonDisabled(true)
            setTimeout(() => {
              if (mounted) setCallButtonDisabled(false)
            }, 3000)
          } else {
            setMediaError(`Connection error: ${err.type || "Unknown error"}`)
          }

          setIsConnected(peer.open)

          // If we're in a call and get a critical error, end the call
          if (callState !== "idle" && ["network", "webrtc", "server-error"].includes(err.type)) {
            endCall()
          }

          // Always release the call lock on errors
          callLockRef.current = false
        })

        // Handle disconnection - but don't auto-reconnect (we'll provide a manual reconnect button)
        peer.on("disconnected", () => {
          if (!mounted) return
          addDebugInfo("Disconnected from signaling server")
          setMediaError("Disconnected from server. Click 'Reconnect' to try again.")
          setIsConnected(false)

          // Release the call lock
          callLockRef.current = false
        })

        peer.on("close", () => {
          if (!mounted) return
          addDebugInfo("Connection closed")
          setIsConnected(false)
          setPeerDestroyed(true)
          setIceConnectionState("closed")
          setCallState("idle")

          // Release the call lock
          callLockRef.current = false
        })
      } catch (err) {
        console.error("Failed to initialize:", err)
        addDebugInfo(`Failed to initialize: ${err}`)
        setMediaError(`Failed to initialize: ${err.message || "Unknown error"}`)

        // Release the call lock
        callLockRef.current = false
      }
    }

    initPeer()

    // Cleanup on unmount
    return () => {
      mounted = false

      // Clear any pending timeouts
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }

      if (callCooldownRef.current) {
        clearTimeout(callCooldownRef.current)
        callCooldownRef.current = null
      }

      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current)
        connectionTimeoutRef.current = null
      }

      if (remoteStreamCheckRef.current) {
        clearInterval(remoteStreamCheckRef.current)
        remoteStreamCheckRef.current = null
      }

      // End any ongoing call
      if (connectionRef.current) {
        try {
          connectionRef.current.close()
        } catch (err) {
          console.error("Error closing call during cleanup:", err)
        }
        connectionRef.current = null
      }

      // Stop all media tracks
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop())
      }

      // Destroy peer connection
      if (peerRef.current) {
        try {
          peerRef.current.destroy()
        } catch (err) {
          console.error("Error destroying peer:", err)
        }
        peerRef.current = null
      }

      // Clear RTC connection
      rtcConnectionRef.current = null

      // Mark peer as destroyed
      setPeerDestroyed(true)

      // Release the call lock
      callLockRef.current = false
    }
  }, []) // Empty dependency array to run only once on mount

  // Function to check if we're using a TURN server (relay)
  const checkIfUsingTurnServer = (pc: RTCPeerConnection) => {
    try {
      // Get stats to check if we're using a relay
      pc.getStats().then((stats) => {
        let usingRelay = false
        stats.forEach((report) => {
          // Look for active candidate pairs
          if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
            // Find the local candidate for this pair
            stats.forEach((r) => {
              if (r.id === report.localCandidateId && r.candidateType === "relay") {
                usingRelay = true
              }
            })
          }
        })

        setUsingTurnServer(usingRelay)

        if (usingRelay) {
          addDebugInfo("Using TURN relay server for connection")
          setMediaError("Using relay server for connection due to network restrictions.")
        } else {
          addDebugInfo("Using direct peer-to-peer connection")
          setMediaError(null)
        }
      })
    } catch (e) {
      console.error("Error checking TURN usage:", e)
      addDebugInfo(`Error checking TURN usage: ${e}`)
    }
  }

  // Function to manually reconnect
  const reconnectPeer = () => {
    // If we're already in a call operation, don't allow reconnect
    if (callLockRef.current) {
      setMediaError("Please wait for the current operation to complete.")
      return
    }

    setIsReconnecting(true)
    setMediaError("Reconnecting to server...")
    addDebugInfo("Manual reconnection initiated")

    // Ensure we don't have any pending reconnection timeouts
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
    }

    // Add a small delay before reconnecting to ensure clean state
    reconnectTimeoutRef.current = setTimeout(() => {
      // End any ongoing call
      if (connectionRef.current) {
        try {
          connectionRef.current.close()
        } catch (err) {
          console.error("Error closing call during reconnect:", err)
          addDebugInfo(`Error closing call during reconnect: ${err}`)
        }
        connectionRef.current = null
      }

      // Clean up existing peer
      if (peerRef.current) {
        try {
          peerRef.current.destroy()
        } catch (err) {
          console.error("Error destroying peer during reconnect:", err)
          addDebugInfo(`Error destroying peer during reconnect: ${err}`)
        }
        peerRef.current = null
      }

      // Reset state for a fresh connection
      setMyPeerId("")
      setIsConnected(false)
      setPeerDestroyed(true)
      setCallState("idle")
      setIceConnectionState("new")
      rtcConnectionRef.current = null
      callLockRef.current = false

      // Clear remote video state
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null
      }
      remoteStreamRef.current = null
      setRemoteStreamReceived(false)
      setRemoteVideoTracks(0)
      setRemoteAudioTracks(0)
      setRemoteStreamActive(false)

      // Stop remote video checks
      if (remoteStreamCheckRef.current) {
        clearInterval(remoteStreamCheckRef.current)
        remoteStreamCheckRef.current = null
      }

      // Reinitialize everything
      const initPeer = async () => {
        try {
          // Import PeerJS dynamically
          addDebugInfo("Importing PeerJS for reconnection")
          const { default: Peer } = await import("peerjs")

          // Create new peer with enhanced ICE configuration
          const peerOptions = {
            debug: 1,
            config: {
              iceServers: [
                // STUN servers
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" },
                { urls: "stun:stun2.l.google.com:19302" },
                { urls: "stun:stun3.l.google.com:19302" },
                { urls: "stun:stun4.l.google.com:19302" },
                // TURN servers
                ...PUBLIC_TURN_SERVERS,
              ],
              sdpSemantics: "unified-plan",
              iceTransportPolicy: "all",
              rtcpMuxPolicy: "require",
              bundlePolicy: "max-bundle",
              iceCandidatePoolSize: 10,
            },
          }

          addDebugInfo("Creating new PeerJS instance for reconnection")
          const peer = new Peer(undefined, peerOptions)
          peerRef.current = peer
          setPeerDestroyed(false)

          // Set up event handlers
          peer.on("open", (id) => {
            addDebugInfo(`Reconnected with new ID: ${id}`)
            setMyPeerId(id)
            setIsConnected(true)
            setMediaError(null)
            setIsReconnecting(false)
          })

          peer.on("error", (err) => {
            console.error("Peer error during reconnect:", err)
            addDebugInfo(`Peer error during reconnect: ${err.type}`)
            setMediaError(`Reconnection error: ${err.type || "Unknown error"}`)
            setIsReconnecting(false)
            callLockRef.current = false
          })

          // Set up other event handlers similar to the initial setup
          // but with simplified logic to avoid duplication
          peer.on("call", (call) => {
            // Only handle calls if we're not already in a call operation
            if (callLockRef.current) {
              try {
                call.close()
              } catch (err) {
                console.error("Error closing conflicting call:", err)
                addDebugInfo(`Error closing conflicting call: ${err}`)
              }
              return
            }

            callLockRef.current = true
            setCallState("connecting")
            addDebugInfo("Incoming call after reconnection")

            setTimeout(() => {
              try {
                call.answer(localStreamRef.current)
                addDebugInfo("Answered call after reconnection")

                call.on("stream", (remoteStream) => {
                  addDebugInfo("Received remote stream after reconnection")

                  // Store the remote stream reference
                  remoteStreamRef.current = remoteStream
                  setRemoteStreamReceived(true)

                  // Check remote stream tracks
                  const videoTracks = remoteStream.getVideoTracks()
                  const audioTracks = remoteStream.getAudioTracks()
                  setRemoteVideoTracks(videoTracks.length)
                  setRemoteAudioTracks(audioTracks.length)

                  if (remoteVideoRef.current) {
                    remoteVideoRef.current.srcObject = remoteStream

                    // Try to play the video
                    remoteVideoRef.current
                      .play()
                      .then(() => {
                        addDebugInfo("Remote video playback started successfully after reconnection")
                        setRemoteStreamActive(true)
                      })
                      .catch((err) => {
                        addDebugInfo(`Error playing remote video after reconnection: ${err}`)
                      })
                  }

                  setCallState("connected")

                  // Start periodic checks of remote video status
                  if (remoteStreamCheckRef.current) {
                    clearInterval(remoteStreamCheckRef.current)
                  }

                  remoteStreamCheckRef.current = setInterval(checkRemoteVideoStatus, 5000)
                })

                call.on("close", () => {
                  setCallState("idle")
                  if (remoteVideoRef.current) {
                    remoteVideoRef.current.srcObject = null
                  }
                  remoteStreamRef.current = null
                  setRemoteStreamReceived(false)
                  setRemoteVideoTracks(0)
                  setRemoteAudioTracks(0)
                  setRemoteStreamActive(false)

                  // Stop remote video checks
                  if (remoteStreamCheckRef.current) {
                    clearInterval(remoteStreamCheckRef.current)
                    remoteStreamCheckRef.current = null
                  }

                  callLockRef.current = false
                  addDebugInfo("Call closed after reconnection")
                })

                connectionRef.current = call
              } catch (err) {
                console.error("Error answering call after reconnect:", err)
                addDebugInfo(`Error answering call after reconnect: ${err}`)
                callLockRef.current = false
                setCallState("idle")
              }
            }, 1000)
          })

          peer.on("disconnected", () => {
            setIsConnected(false)
            setMediaError("Disconnected from server. Click 'Reconnect' to try again.")
            callLockRef.current = false
            addDebugInfo("Disconnected after reconnection")
          })

          peer.on("close", () => {
            setIsConnected(false)
            setPeerDestroyed(true)
            setCallState("idle")
            callLockRef.current = false
            addDebugInfo("Connection closed after reconnection")
          })
        } catch (err) {
          console.error("Failed to reconnect:", err)
          addDebugInfo(`Failed to reconnect: ${err}`)
          setMediaError(`Failed to reconnect: ${err.message || "Unknown error"}`)
          setIsReconnecting(false)
          callLockRef.current = false
        }
      }

      initPeer()
    }, 1000)
  }

  // Function to start a call with strict state management
  const startCall = () => {
    // If we're already in a call operation, don't allow starting a new one
    if (callLockRef.current) {
      setMediaError("Please wait for the current operation to complete.")
      return
    }

    // Add this check to prevent calling yourself
    if (myPeerId === remotePeerId) {
      setMediaError("You cannot call yourself. Please enter a different Peer ID.")
      return
    }

    if (!peerRef.current || !remotePeerId || peerDestroyed) {
      setMediaError("Connection not available. Please reconnect first.")
      return
    }

    // Set the call lock to prevent concurrent operations
    callLockRef.current = true

    // Disable the call button to prevent multiple rapid call attempts
    setCallButtonDisabled(true)

    // Set a timeout to re-enable the button after a cooldown period
    if (callCooldownRef.current) {
      clearTimeout(callCooldownRef.current)
    }
    callCooldownRef.current = setTimeout(() => {
      setCallButtonDisabled(false)
    }, 3000) // 3 second cooldown

    try {
      addDebugInfo(`Starting call to: ${remotePeerId}`)
      setMediaError(null)
      setIceConnectionState("new")
      setCallState("connecting")
      setConnectionTimeout(0)
      setRemoteStreamReceived(false)
      setRemoteVideoTracks(0)
      setRemoteAudioTracks(0)
      setRemoteStreamActive(false)

      // End any existing call first to ensure clean state
      if (connectionRef.current) {
        addDebugInfo("Ending existing call before starting new one")
        try {
          connectionRef.current.close()
        } catch (err) {
          console.error("Error closing existing call:", err)
          addDebugInfo(`Error closing existing call: ${err}`)
        }
        connectionRef.current = null

        // Clear remote video
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = null
        }
        remoteStreamRef.current = null

        // Add a longer delay before starting a new call to ensure clean state
        setTimeout(() => initiateNewCall(), 2000)
      } else {
        // No existing call, proceed after a short delay
        setTimeout(() => initiateNewCall(), 500)
      }
    } catch (err) {
      console.error("Error starting call:", err)
      addDebugInfo(`Error starting call: ${err}`)
      setMediaError(`Error starting call: ${err.message || "Unknown error"}`)
      setCallState("idle")
      setCallButtonDisabled(false)
      callLockRef.current = false
    }
  }

  // Helper function to initiate a new call with better error handling
  const initiateNewCall = () => {
    try {
      // Make sure we have a stream to send, even if it's empty
      if (!localStreamRef.current) {
        localStreamRef.current = new MediaStream()
      }

      // Make sure peer is still valid
      if (!peerRef.current || peerDestroyed) {
        setMediaError("Connection lost. Please reconnect first.")
        setCallButtonDisabled(false)
        setCallState("idle")
        callLockRef.current = false
        return
      }

      addDebugInfo(`Initiating call to peer: ${remotePeerId}`)

      // Call the remote peer
      const call = peerRef.current.call(remotePeerId, localStreamRef.current)

      if (!call) {
        addDebugInfo("Failed to create call object")
        setMediaError("Failed to establish call. Please try again.")
        setCallButtonDisabled(false)
        setCallState("idle")
        callLockRef.current = false
        return
      }

      // Start connection timeout counter
      let timeoutCounter = 0
      if (connectionTimeoutRef.current) {
        clearInterval(connectionTimeoutRef.current)
      }

      connectionTimeoutRef.current = setInterval(() => {
        if (callState === "connecting") {
          timeoutCounter++
          setConnectionTimeout(timeoutCounter)

          // After 30 seconds, show additional help message
          if (timeoutCounter >= 30) {
            addDebugInfo("Connection attempt taking too long")
            setMediaError(
              "Connection is taking longer than expected. The remote peer may be unavailable or behind a restrictive firewall.",
            )

            // After 60 seconds, auto-cancel the call
            if (timeoutCounter >= 60) {
              addDebugInfo("Connection timed out after 60 seconds")
              clearInterval(connectionTimeoutRef.current)
              connectionTimeoutRef.current = null
              endCall()
            }
          }
        } else {
          // If call state changed, clear the interval
          clearInterval(connectionTimeoutRef.current)
          connectionTimeoutRef.current = null
        }
      }, 1000)

      // Handle receiving remote stream
      call.on("stream", (remoteStream: MediaStream) => {
        addDebugInfo("Received remote stream")
        if (connectionTimeoutRef.current) {
          clearInterval(connectionTimeoutRef.current)
          connectionTimeoutRef.current = null
        }

        // Store the remote stream reference
        remoteStreamRef.current = remoteStream
        setRemoteStreamReceived(true)

        // Check remote stream tracks
        const videoTracks = remoteStream.getVideoTracks()
        const audioTracks = remoteStream.getAudioTracks()
        setRemoteVideoTracks(videoTracks.length)
        setRemoteAudioTracks(audioTracks.length)

        addDebugInfo(`Remote stream has ${videoTracks.length} video tracks and ${audioTracks.length} audio tracks`)

        if (videoTracks.length === 0) {
          addDebugInfo("Warning: Remote stream has no video tracks")
        }

        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remoteStream

          // Try to play the video
          remoteVideoRef.current
            .play()
            .then(() => {
              addDebugInfo("Remote video playback started successfully")
              setRemoteStreamActive(true)
            })
            .catch((err) => {
              addDebugInfo(`Error playing remote video: ${err}`)
            })
        } else {
          addDebugInfo("Error: Remote video element not available")
        }

        setCallState("connected")

        // Start periodic checks of remote video status
        if (remoteStreamCheckRef.current) {
          clearInterval(remoteStreamCheckRef.current)
        }

        remoteStreamCheckRef.current = setInterval(checkRemoteVideoStatus, 5000)
      })

      // Handle call close
      call.on("close", () => {
        addDebugInfo("Call closed")
        if (connectionTimeoutRef.current) {
          clearInterval(connectionTimeoutRef.current)
          connectionTimeoutRef.current = null
        }
        setCallState("idle")

        // Clear remote video
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = null
        }
        remoteStreamRef.current = null
        setRemoteStreamReceived(false)
        setRemoteVideoTracks(0)
        setRemoteAudioTracks(0)
        setRemoteStreamActive(false)

        // Stop remote video checks
        if (remoteStreamCheckRef.current) {
          clearInterval(remoteStreamCheckRef.current)
          remoteStreamCheckRef.current = null
        }

        // Release the call lock
        callLockRef.current = false
      })

      // Handle call errors
      call.on("error", (err) => {
        addDebugInfo(`Call error: ${err}`)
        if (connectionTimeoutRef.current) {
          clearInterval(connectionTimeoutRef.current)
          connectionTimeoutRef.current = null
        }
        console.error("Call error:", err)
        setMediaError(`Call error: ${err}`)
        setCallState("failed")

        // End the call on error
        if (connectionRef.current === call) {
          endCall()
        } else {
          // If it's not the current call, just release the lock
          callLockRef.current = false
        }
      })

      connectionRef.current = call

      // Access the underlying RTCPeerConnection to monitor ICE connection state
      // @ts-ignore - accessing internal PeerJS property
      const pc = call.peerConnection
      if (pc) {
        rtcConnectionRef.current = pc

        // Monitor ICE connection state
        pc.addEventListener("iceconnectionstatechange", () => {
          const state = pc.iceConnectionState
          addDebugInfo(`ICE connection state changed: ${state}`)
          setIceConnectionState(state)

          if (state === "connected" || state === "completed") {
            checkIfUsingTurnServer(pc)
          }

          if (state === "failed") {
            addDebugInfo("ICE connection failed")
            setMediaError("WebRTC connection failed. The app is trying to use a relay server.")
            setCallState("failed")

            // End the call after a delay
            setTimeout(() => {
              if (connectionRef.current === call) {
                endCall()
              }
            }, 1000)
          }
        })

        // Log ICE candidates for debugging
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            addDebugInfo(`ICE candidate: ${event.candidate.candidate.substring(0, 50)}...`)
          }
        }
      }
    } catch (err) {
      console.error("Error initiating new call:", err)
      addDebugInfo(`Error initiating new call: ${err}`)
      setMediaError(`Error initiating call: ${err.message || "Unknown error"}`)
      setCallState("idle")
      setCallButtonDisabled(false)
      callLockRef.current = false
    }
  }

  // Function to end the call with proper cleanup
  const endCall = () => {
    addDebugInfo("Ending call")
    setCallState("disconnecting")

    if (connectionTimeoutRef.current) {
      clearInterval(connectionTimeoutRef.current)
      connectionTimeoutRef.current = null
    }

    if (remoteStreamCheckRef.current) {
      clearInterval(remoteStreamCheckRef.current)
      remoteStreamCheckRef.current = null
    }

    if (connectionRef.current) {
      try {
        connectionRef.current.close()
      } catch (err) {
        console.error("Error closing call:", err)
        addDebugInfo(`Error closing call: ${err}`)
      }
      connectionRef.current = null
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }
    remoteStreamRef.current = null
    setRemoteStreamReceived(false)
    setRemoteVideoTracks(0)
    setRemoteAudioTracks(0)
    setRemoteStreamActive(false)

    // Reset state
    setCallState("idle")
    setIceConnectionState("closed")
    rtcConnectionRef.current = null

    // Release the call lock after a delay to prevent immediate new calls
    setTimeout(() => {
      callLockRef.current = false
    }, 1000)
  }

  // Function to copy peer ID to clipboard
  const copyPeerId = () => {
    navigator.clipboard.writeText(myPeerId)
    addDebugInfo("Copied peer ID to clipboard")
  }

  // Toggle video
  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks()
      videoTracks.forEach((track) => {
        track.enabled = !track.enabled
      })
      setVideoEnabled(!videoEnabled)
      addDebugInfo(`Video ${!videoEnabled ? "enabled" : "disabled"}`)
    }
  }

  // Toggle audio
  const toggleAudio = () => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks()
      audioTracks.forEach((track) => {
        track.enabled = !track.enabled
      })
      setAudioEnabled(!audioEnabled)
      addDebugInfo(`Audio ${!audioEnabled ? "enabled" : "disabled"}`)
    }
  }

  // Function to clear error messages
  const clearError = () => {
    setMediaError(null)
  }

  // Helper function to get connection status text and color
  const getConnectionStatusInfo = () => {
    if (!isConnected) {
      return { text: "Disconnected from server", color: "bg-red-500" }
    }

    if (callState === "idle") {
      return { text: "Connected to server", color: "bg-green-500" }
    }

    // Call is in progress, show more detailed state
    switch (callState) {
      case "connecting":
        return {
          text:
            connectionTimeout > 0 ? `Establishing connection... (${connectionTimeout}s)` : "Establishing connection...",
          color: "bg-yellow-500",
        }
      case "connected":
        if (!remoteStreamReceived) {
          return { text: "Connected, waiting for media...", color: "bg-yellow-500" }
        }
        return {
          text: usingTurnServer ? "Connected via relay server" : "Connected directly",
          color: usingTurnServer ? "bg-yellow-500" : "bg-green-500",
        }
      case "disconnecting":
        return { text: "Ending call...", color: "bg-yellow-500" }
      case "failed":
        return { text: "Connection failed", color: "bg-red-500" }
      default:
        return { text: "Unknown state", color: "bg-gray-500" }
    }
  }

  const connectionStatus = getConnectionStatusInfo()
  const isCallInProgress = callState === "connected" || callState === "connecting"

  // Function to force refresh remote video
  const refreshRemoteVideo = () => {
    if (remoteStreamRef.current && remoteVideoRef.current) {
      addDebugInfo("Manually refreshing remote video")

      // Temporarily remove and reattach the stream
      const stream = remoteStreamRef.current
      remoteVideoRef.current.srcObject = null

      // Short delay before reattaching
      setTimeout(() => {
        if (remoteVideoRef.current && stream) {
          remoteVideoRef.current.srcObject = stream
          remoteVideoRef.current
            .play()
            .then(() => {
              addDebugInfo("Remote video refreshed and playing")
              setRemoteStreamActive(true)
            })
            .catch((err) => {
              addDebugInfo(`Error playing remote video after refresh: ${err}`)
            })
        }
      }, 500)
    } else {
      addDebugInfo("Cannot refresh remote video - no stream available")
    }
  }

  return (
    <div className="grid gap-6">
      {mediaError && (
        <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-4">
          <div className="flex justify-between">
            <div className="flex">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
              <div className="ml-3">
                <p className="text-sm text-yellow-700">{mediaError}</p>
              </div>
            </div>
            <button onClick={clearError} className="text-yellow-700 hover:text-yellow-900">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Local Video */}
        <Card className="overflow-hidden">
          <CardHeader className="p-4">
            <CardTitle className="text-lg">Your Camera</CardTitle>
          </CardHeader>
          <CardContent className="p-0 aspect-video bg-black relative">
            <video ref={localVideoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
            {!videoEnabled && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
                <div className="text-white text-center">
                  <VideoOff size={48} className="mx-auto mb-2 opacity-50" />
                  <p>Camera unavailable</p>
                </div>
              </div>
            )}
            <div className="absolute bottom-4 right-4 flex gap-2">
              <Button
                variant="secondary"
                size="icon"
                className="rounded-full"
                onClick={toggleVideo}
                disabled={mediaError && !videoEnabled}
              >
                {videoEnabled ? <Video size={18} /> : <VideoOff size={18} />}
              </Button>
              <Button
                variant="secondary"
                size="icon"
                className="rounded-full"
                onClick={toggleAudio}
                disabled={mediaError && !audioEnabled}
              >
                {audioEnabled ? <Mic size={18} /> : <MicOff size={18} />}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Remote Video */}
        <Card className="overflow-hidden">
          <CardHeader className="p-4 flex justify-between items-center">
            <CardTitle className="text-lg">Remote Camera</CardTitle>
            {remoteStreamReceived && (
              <Button variant="ghost" size="sm" onClick={refreshRemoteVideo} className="text-xs">
                <RefreshCw className="mr-1 h-3 w-3" /> Refresh Video
              </Button>
            )}
          </CardHeader>
          <CardContent className="p-0 aspect-video bg-black flex items-center justify-center relative">
            <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />

            {/* Remote video status overlay */}
            {callState !== "connected" && (
              <div className="absolute text-white text-center">
                {callState === "connecting"
                  ? connectionTimeout > 0
                    ? `Connecting... (${connectionTimeout}s)`
                    : "Connecting..."
                  : isConnected
                    ? "Waiting for connection..."
                    : "Not connected"}
              </div>
            )}

            {/* Show remote camera status when connected but no video */}
            {callState === "connected" && remoteStreamReceived && !remoteStreamActive && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-70">
                <div className="text-white text-center p-4">
                  <Camera size={48} className="mx-auto mb-2 opacity-50" />
                  <p className="mb-1">Remote camera issue</p>
                  <p className="text-xs mb-3">
                    {remoteVideoTracks === 0
                      ? "The remote user's camera is not available"
                      : "Video stream received but not playing"}
                  </p>
                  <Button size="sm" variant="outline" onClick={refreshRemoteVideo}>
                    <RefreshCw className="mr-2 h-4 w-4" /> Try to refresh
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="flex justify-between items-center">
            <span>Connection Controls</span>
            <Button variant="ghost" size="sm" onClick={() => setShowDebug(!showDebug)} className="text-xs">
              {showDebug ? "Hide Debug Info" : "Show Debug Info"}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Connection Status and Reconnect Button */}
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <div className={`w-3 h-3 rounded-full ${connectionStatus.color}`}></div>
              <span className="text-sm">{connectionStatus.text}</span>
              {usingTurnServer && (
                <div className="flex items-center ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full">
                  <Shield size={12} className="mr-1" /> Using relay
                </div>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={reconnectPeer}
              disabled={isReconnecting || (isConnected && !peerDestroyed) || callLockRef.current}
            >
              {isReconnecting ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Reconnecting...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" /> Reconnect
                </>
              )}
            </Button>
          </div>

          {/* Your Peer ID */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Your Peer ID</label>
            <div className="flex gap-2">
              <Input value={myPeerId} readOnly placeholder={isConnected ? "Getting ID..." : "Not connected"} />
              <Button variant="outline" onClick={copyPeerId} disabled={!myPeerId}>
                <Copy size={18} />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Share this ID with the person you want to call</p>
          </div>

          {/* Remote Peer ID */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Remote Peer ID</label>
            <Input
              value={remotePeerId}
              onChange={(e) => setRemotePeerId(e.target.value)}
              placeholder="Enter remote peer ID"
              disabled={isCallInProgress}
            />
          </div>

          {/* Remote Media Status */}
          {callState === "connected" && remoteStreamReceived && (
            <div className="p-3 bg-gray-50 border border-gray-200 rounded-md">
              <h4 className="text-sm font-medium mb-2">Remote Media Status</h4>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex items-center">
                  <div
                    className={`w-2 h-2 rounded-full ${remoteVideoTracks > 0 ? "bg-green-500" : "bg-red-500"} mr-2`}
                  ></div>
                  <span>Video Tracks: {remoteVideoTracks}</span>
                </div>
                <div className="flex items-center">
                  <div
                    className={`w-2 h-2 rounded-full ${remoteAudioTracks > 0 ? "bg-green-500" : "bg-red-500"} mr-2`}
                  ></div>
                  <span>Audio Tracks: {remoteAudioTracks}</span>
                </div>
                <div className="flex items-center">
                  <div
                    className={`w-2 h-2 rounded-full ${remoteStreamActive ? "bg-green-500" : "bg-yellow-500"} mr-2`}
                  ></div>
                  <span>Video Playing: {remoteStreamActive ? "Yes" : "No"}</span>
                </div>
                <div className="flex items-center">
                  <div
                    className={`w-2 h-2 rounded-full ${iceConnectionState === "connected" || iceConnectionState === "completed" ? "bg-green-500" : "bg-yellow-500"} mr-2`}
                  ></div>
                  <span>Connection: {iceConnectionState}</span>
                </div>
              </div>
            </div>
          )}

          {/* Debug Info */}
          {showDebug && (
            <div className="mt-4 p-2 bg-gray-100 rounded-md">
              <h3 className="text-sm font-medium mb-2">Debug Information</h3>
              <div className="text-xs font-mono bg-black text-green-400 p-2 rounded h-40 overflow-y-auto">
                {debugInfo.map((info, index) => (
                  <div key={index}>{info}</div>
                ))}
              </div>
            </div>
          )}

          {/* Connection Troubleshooting */}
          {callState === "connecting" && connectionTimeout > 15 && (
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
              <div className="flex items-start">
                <AlertCircle className="h-5 w-5 text-blue-500 mr-2 mt-0.5" />
                <div>
                  <h4 className="text-sm font-medium text-blue-800">Connection taking too long?</h4>
                  <ul className="text-xs text-blue-700 mt-1 list-disc pl-5">
                    <li>Make sure the remote peer ID is correct</li>
                    <li>Verify that the other person is online and ready to receive calls</li>
                    <li>Try clicking "Reconnect" on both sides</li>
                    <li>If behind a firewall, try connecting from a different network</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Remote Camera Troubleshooting */}
          {callState === "connected" && remoteStreamReceived && !remoteStreamActive && (
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
              <div className="flex items-start">
                <AlertCircle className="h-5 w-5 text-blue-500 mr-2 mt-0.5" />
                <div>
                  <h4 className="text-sm font-medium text-blue-800">Remote camera not showing?</h4>
                  <ul className="text-xs text-blue-700 mt-1 list-disc pl-5">
                    <li>Ask the remote user to check if their camera is enabled</li>
                    <li>Try clicking the "Refresh Video" button above the remote video</li>
                    <li>Both users should try clicking "Reconnect" and start a new call</li>
                    <li>The remote user might need to grant camera permissions in their browser</li>
                    <li>Try a different browser (Chrome works best for WebRTC)</li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </CardContent>
        <CardFooter className="flex justify-between">
          {isCallInProgress ? (
            <Button variant="destructive" onClick={endCall} className="w-full">
              <PhoneOff className="mr-2 h-4 w-4" /> End Call
            </Button>
          ) : (
            <Button
              onClick={startCall}
              disabled={!isConnected || !remotePeerId || peerDestroyed || callButtonDisabled || callLockRef.current}
              className="w-full"
            >
              <Phone className="mr-2 h-4 w-4" /> Start Call
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  )
}
