import { useCallback, useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import { emitAck } from "../services/socket";

/**
 * What to capture and how much to spend sending it, when the server has not
 * said.
 *
 * The server does say -- it hands a profile over at join time so the numbers
 * can be tuned from a `.env` file rather than by rebuilding this. These are
 * the fallback for an older server, and they are also the documentation: the
 * teacher's tile is a few hundred pixels wide, so capturing 720p and spending
 * two megabits a second on it was paid for by every person in the room and
 * visible to none of them.
 */
const DEFAULT_PROFILE = {
  camera: {
    width: 640,
    height: 360,
    frameRate: 20,
    maxBitrate: 300000,
    degradationPreference: "maintain-framerate",
  },
  screen: { maxBitrate: 1200000, maxFramerate: 24 },
};

/** getUserMedia constraints for the camera, from the profile in force. */
function camConstraints(profile) {
  const cam = profile?.camera || DEFAULT_PROFILE.camera;
  return {
    width: { ideal: cam.width },
    height: { ideal: cam.height },
    // `max`, not `ideal`: a webcam offered 30 will take 30, and the point here
    // is to not be sent 30.
    frameRate: { max: cam.frameRate },
  };
}

/**
 * The encoding a producer is created with.
 *
 * maxBitrate is the whole point of this change. Without it the encoder is
 * told only what the picture is, and decides for itself what it is worth --
 * which for a moving 720p picture is a megabit or two.
 */
function camEncodings(profile) {
  const cam = profile?.camera || DEFAULT_PROFILE.camera;
  return {
    encodings: [{ maxBitrate: cam.maxBitrate, maxFramerate: cam.frameRate }],
    codecOptions: {
      // Starting near the ceiling rather than crawling up to it: the first
      // seconds of a lesson should not look like the worst of it.
      videoGoogleStartBitrate: Math.round(cam.maxBitrate / 1000),
      videoGoogleMaxBitrate: Math.round(cam.maxBitrate / 1000),
    },
  };
}

/**
 * The stage is a page being read as often as it is a video being watched, so
 * it is given the room to stay legible -- and a low frame rate, because a
 * whiteboard is still most of the time.
 */
function stageEncodings(profile) {
  const screen = profile?.screen || DEFAULT_PROFILE.screen;
  return {
    encodings: [{ maxBitrate: screen.maxBitrate, maxFramerate: 15 }],
    codecOptions: { videoGoogleStartBitrate: Math.round(screen.maxBitrate / 1000) },
  };
}

function screenEncodings(profile) {
  const screen = profile?.screen || DEFAULT_PROFILE.screen;
  return {
    encodings: [{ maxBitrate: screen.maxBitrate, maxFramerate: screen.maxFramerate }],
    codecOptions: { videoGoogleStartBitrate: Math.round(screen.maxBitrate / 1000) },
  };
}

/**
 * Asks the encoder to sacrifice sharpness rather than smoothness.
 *
 * A talking head that stutters reads as a broken connection; one that softens
 * for a moment reads as nothing at all. This is not part of produce(), so it is
 * set on the sender afterwards -- and it is entirely optional: a browser that
 * does not offer the sender, or the setting, simply keeps its own default.
 */
async function preferSmoothness(producer, preference) {
  try {
    const sender = producer?.rtpSender;
    if (!sender || typeof sender.getParameters !== "function") return;
    const params = sender.getParameters();
    params.degradationPreference = preference;
    await sender.setParameters(params);
    console.log("[Mediasoup] degradationPreference", preference);
  } catch (err) {
    console.warn("[Mediasoup] could not set degradationPreference", err.message);
  }
}

/**
 * Tells the server about a camera change without making the hardware wait for
 * the answer.
 *
 * emitAck resolves on an acknowledgement and has no timeout, so a socket that
 * is slow, reconnecting or gone leaves the promise pending forever. Awaiting it
 * before stopping the track would mean a network hiccup keeps the camera --
 * and its light -- running, which is the one thing this must never do. The
 * device is a promise to the person sitting in front of it; the server hearing
 * about it is bookkeeping.
 */
function signalVideo(event) {
  emitAck(event, { source: "video" }).catch((err) =>
    console.error(`[Mediasoup] ${event} failed`, err),
  );
}

export function useMediasoup({ socket, role, peerId, enabled, profile }) {
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  const producersRef = useRef({});
  const consumersRef = useRef(new Map());
  const peerIdRef = useRef(peerId);
  // Held while a camera is being acquired or released, so the button cannot
  // start a second capture on top of the first.
  const camBusyRef = useRef(false);
  /** The server's media profile, read wherever a track is created. */
  const profileRef = useRef(profile || DEFAULT_PROFILE);
  profileRef.current = profile || DEFAULT_PROFILE;

  const [localStream, setLocalStream] = useState(null);
  const [teacherStream, setTeacherStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [remoteAudio, setRemoteAudio] = useState([]);
  // Only the teacher joins live; everyone else arrives muted.
  const [micOn, setMicOn] = useState(role === "teacher");
  const [camOn, setCamOn] = useState(role === "teacher");
  const [sharing, setSharing] = useState(false);
  const [ready, setReady] = useState(false);

  /**
   * The live capture, held in a ref as well as in state.
   *
   * State is what the tile renders from; this is what the code reaches for
   * when it has to release a device. They must not be allowed to disagree:
   * `cleanup` is called from socket handlers registered once, so reading the
   * stream out of a closure there means stopping whatever was current when the
   * handler was created -- often nothing at all, while the real camera stays
   * open and its light stays on.
   */
  const localStreamRef = useRef(null);
  /** The getDisplayMedia capture, for the same reason. */
  const localScreenRef = useRef(null);
  /** The tab capture that is recorded as the stage, while recording runs. */
  const stageStreamRef = useRef(null);

  const teacherStreamRef = useRef(new MediaStream());
  const screenStreamRef = useRef(new MediaStream());
  const remoteAudioRef = useRef(new Map());
  // producerId -> track, so a teacher track can be dropped when its producer
  // goes rather than lingering in the stream.
  const teacherTracksRef = useRef(new Map());

  useEffect(() => {
    peerIdRef.current = peerId;
  }, [peerId]);

  /** The one way the local stream changes, so the ref can never fall behind. */
  const applyLocalStream = useCallback((stream) => {
    localStreamRef.current = stream;
    setLocalStream(stream);
  }, []);

  /** Releases every device a stream is holding. Safe to call on nothing. */
  const releaseStream = useCallback((stream) => {
    for (const track of stream ? stream.getTracks() : []) {
      try {
        track.stop();
      } catch (err) {
        console.error("[Mediasoup] track.stop failed", err);
      }
    }
  }, []);

  const publishRemoteAudio = useCallback(() => {
    setRemoteAudio(
      [...remoteAudioRef.current.entries()].map(([id, stream]) => ({ id, stream })),
    );
  }, []);

  const publishTeacherStream = useCallback(() => {
    const tracks = teacherStreamRef.current.getTracks();
    setTeacherStream(tracks.length ? new MediaStream(tracks) : null);
  }, []);

  /**
   * Puts a teacher track into the stream, replacing whatever was there for that
   * kind.
   *
   * A teacher who reconnects publishes a new camera, and the old track was
   * simply added alongside the dead one. The browser kept rendering whichever
   * it picked first, so the teacher came back to the meeting but their tile
   * stayed frozen on a track that would never carry another frame.
   */
  const setTeacherTrack = useCallback(
    (track, producerId) => {
      for (const existing of teacherStreamRef.current.getTracks()) {
        if (existing.kind !== track.kind) continue;
        teacherStreamRef.current.removeTrack(existing);
        for (const [id, t] of teacherTracksRef.current) {
          if (t === existing) teacherTracksRef.current.delete(id);
        }
      }
      teacherStreamRef.current.addTrack(track);
      if (producerId) teacherTracksRef.current.set(producerId, track);
      publishTeacherStream();
    },
    [publishTeacherStream],
  );

  const attachRemoteTrack = useCallback(
    (track, source, producer) => {
      try {
        console.log("[Mediasoup] attachRemoteTrack", source, track.kind, producer?.role, producer?.peerId);
        if (source === "screen") {
          screenStreamRef.current.addTrack(track);
          setScreenStream(new MediaStream(screenStreamRef.current.getTracks()));
          return;
        }
        /**
         * The sound of a shared screen.
         *
         * Checked before the teacher-audio branch below, which would otherwise
         * put it in the instructor tile and throw the teacher's microphone out
         * to make room -- the class would hear the video and lose the teacher.
         * It plays through the same sinks as everyone else's audio.
         */
        if (source === "screen-audio") {
          remoteAudioRef.current.set(producer.producerId, new MediaStream([track]));
          publishRemoteAudio();
          return;
        }
        if (track.kind === "video") {
          setTeacherTrack(track, producer?.producerId);
          return;
        }
        if (track.kind === "audio") {
          if (producer?.role === "teacher") {
            setTeacherTrack(track, producer?.producerId);
            return;
          }
          const stream = new MediaStream([track]);
          remoteAudioRef.current.set(producer.producerId, stream);
          publishRemoteAudio();
        }
      } catch (err) {
        console.error("[Mediasoup] attachRemoteTrack failed", err);
      }
    },
    [publishRemoteAudio, setTeacherTrack],
  );

  const consumeProducer = useCallback(
    async (producer) => {
      try {
        if (!deviceRef.current || !recvTransportRef.current) return;
        if (!producer) return;
        if (producer.peerId && producer.peerId === peerIdRef.current) {
          console.log("[Mediasoup] skip own producer", producer);
          return;
        }
        /**
         * The stage is the teacher's own tab, published for the recorder
         * alone. Consuming it would show every student a mirror of the
         * teacher's interface and cost them a second video stream to see
         * what they are already looking at.
         */
        if (producer.source === "stage") {
          console.log("[Mediasoup] skip the stage capture — it is for the recording");
          return;
        }
        if (producer.source === "video" || producer.source === "screen") {
          if (producer.role === "student") {
            console.log("[Mediasoup] skip student video/screen", producer);
            return;
          }
        }
        console.log("[Mediasoup] consumeProducer", producer);
        const res = await emitAck("consume", {
          producerId: producer.producerId,
          transportId: recvTransportRef.current.id,
          rtpCapabilities: deviceRef.current.rtpCapabilities,
        });
        const { params } = res;
        const consumer = await recvTransportRef.current.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
        });
        consumersRef.current.set(consumer.id, consumer);
        attachRemoteTrack(consumer.track, producer.source, producer);
        await emitAck("resume-consumer", { consumerId: consumer.id });
      } catch (err) {
        console.error("[Mediasoup] consumeProducer failed", err);
      }
    },
    [attachRemoteTrack],
  );

  const startLocalMedia = useCallback(async () => {
    try {
      const wantCam = role === "teacher";
      const constraints = wantCam
        ? { audio: true, video: camConstraints(profileRef.current) }
        : { audio: true, video: false };
      console.log("[Mediasoup] getUserMedia", constraints, { role });
      // A reconnect runs this again, and the previous capture is still holding
      // the camera and microphone. Left alone, the machine ends up with two
      // streams owning the device and only one of them is ever switched off --
      // so the light stays on no matter what the button says.
      releaseStream(localStreamRef.current);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      applyLocalStream(stream);
      if (role === "teacher") setTeacherStream(stream);

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && sendTransportRef.current) {
        const producer = await sendTransportRef.current.produce({
          track: audioTrack,
          appData: { source: "audio" },
        });
        producersRef.current.audio = producer;
        // The server pauses non-teacher audio on produce; kill the local track
        // too so nothing leaves the machine before that lands.
        if (role !== "teacher") {
          audioTrack.enabled = false;
          setMicOn(false);
        }
        console.log("[Mediasoup] audio producer created", { role, muted: role !== "teacher" });
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && role === "teacher" && sendTransportRef.current) {
        // A face rather than a spreadsheet: the encoder is told so, and will
                // spend its bits on faces rather than on edges.
        try {
          videoTrack.contentHint = "motion";
        } catch (err) {
          console.warn("[Mediasoup] contentHint not supported", err.message);
        }
        const producer = await sendTransportRef.current.produce({
          track: videoTrack,
          ...camEncodings(profileRef.current),
          appData: { source: "video" },
        });
        producersRef.current.video = producer;
        await preferSmoothness(producer, profileRef.current.camera?.degradationPreference);
        setCamOn(true);
      }
    } catch (err) {
      console.error("[Mediasoup] startLocalMedia failed", err);
      throw err;
    }
  }, [role, applyLocalStream, releaseStream]);

  const initDevice = useCallback(
    async ({ routerRtpCapabilities, iceServers }) => {
      try {
        console.log("[Mediasoup] initDevice", { role, peerId: peerIdRef.current });
        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities });
        deviceRef.current = device;

        const makeTransport = async (direction) => {
          const { params } = await emitAck("create-transport", { direction });
          const transport =
            direction === "send"
              ? device.createSendTransport({ ...params, iceServers })
              : device.createRecvTransport({ ...params, iceServers });

          transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
            try {
              console.log("[Mediasoup] transport connect", direction);
              await emitAck("connect-transport", {
                transportId: transport.id,
                dtlsParameters,
              });
              callback();
            } catch (err) {
              console.error("[Mediasoup] transport connect failed", err);
              errback(err);
            }
          });

          if (direction === "send") {
            transport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
              try {
                console.log("[Mediasoup] produce", kind, appData);
                // Never guess this. The server replaces the existing producer
                // for whatever source it is told, so a screen share arriving
                // labelled "video" would close the teacher's camera and take
                // its place -- the camera would vanish and the share would
                // never be recognised as a share.
                const source = appData?.source;
                if (!source) {
                  throw new Error(`produce is missing appData.source for a ${kind} track`);
                }
                const res = await emitAck("produce", {
                  transportId: transport.id,
                  kind,
                  rtpParameters,
                  source,
                });
                callback({ id: res.id });
              } catch (err) {
                console.error("[Mediasoup] produce event failed", err);
                errback(err);
              }
            });
          }

          transport.on("connectionstatechange", (state) => {
            console.log("[Mediasoup] transport state", direction, state);
          });

          return transport;
        };

        sendTransportRef.current = await makeTransport("send");
        recvTransportRef.current = await makeTransport("recv");
        setReady(true);
        await startLocalMedia();
      } catch (err) {
        console.error("[Mediasoup] initDevice failed", err);
        throw err;
      }
    },
    [startLocalMedia, role],
  );

  useEffect(() => {
    if (!socket || !enabled) return undefined;

    const onNew = (producer) => {
      console.log("[Mediasoup] new-producer", producer);
      consumeProducer(producer);
    };
    const onClosed = ({ producerId, source }) => {
      console.log("[Mediasoup] producer-closed", producerId, source);
      if (source === "screen") {
        screenStreamRef.current = new MediaStream();
        setScreenStream(null);
        setSharing(false);
      }
      const teacherTrack = teacherTracksRef.current.get(producerId);
      if (teacherTrack) {
        teacherTracksRef.current.delete(producerId);
        teacherStreamRef.current.removeTrack(teacherTrack);
        publishTeacherStream();
      }
      if (remoteAudioRef.current.has(producerId)) {
        remoteAudioRef.current.delete(producerId);
        publishRemoteAudio();
      }
    };

    // Server already paused the producer — just reflect it locally.
    const onMicLocked = () => {
      if (role !== "student") return;
      console.log("[Mediasoup] mic-locked received");
      localStream?.getAudioTracks().forEach((t) => {
        t.enabled = false;
      });
      setMicOn(false);
    };

    socket.on("new-producer", onNew);
    socket.on("producer-closed", onClosed);
    // Applies to students and coordinators alike, unlike mic-locked which is
    // a students-only rule.
    const onJoinedMuted = () => {
      if (role === "teacher") return;
      console.log("[Mediasoup] joined-muted received");
      localStream?.getAudioTracks().forEach((t) => {
        t.enabled = false;
      });
      setMicOn(false);
    };

    socket.on("mic-locked", onMicLocked);
    socket.on("joined-muted", onJoinedMuted);
    socket.on("force-mute", async () => {
      try {
        if (role !== "student") return;
        console.log("[Mediasoup] force-mute received");
        await emitAck("pause-producer", { source: "audio" });
        localStream?.getAudioTracks().forEach((t) => {
          t.enabled = false;
        });
        setMicOn(false);
      } catch (err) {
        console.error("[Mediasoup] force-mute failed", err);
      }
    });

    return () => {
      socket.off("new-producer", onNew);
      socket.off("producer-closed", onClosed);
      socket.off("mic-locked", onMicLocked);
      socket.off("joined-muted", onJoinedMuted);
      socket.off("force-mute");
    };
  }, [socket, enabled, consumeProducer, localStream, role, publishRemoteAudio, publishTeacherStream]);

  const consumeExisting = useCallback(
    async (producers = []) => {
      try {
        console.log("[Mediasoup] consumeExisting", producers);
        for (const p of producers) {
          await consumeProducer(p);
        }
      } catch (err) {
        console.error("[Mediasoup] consumeExisting failed", err);
      }
    },
    [consumeProducer],
  );

  const toggleMic = useCallback(async () => {
    const next = !micOn;
    console.log("[Mediasoup] toggleMic", next, { role });
    // Ask the server before opening the track — an unmute can be refused.
    await emitAck(next ? "resume-producer" : "pause-producer", { source: "audio" });
    localStream?.getAudioTracks().forEach((t) => {
      t.enabled = next;
    });
    setMicOn(next);
  }, [micOn, localStream, role]);

  /**
   * Camera off means the camera is off.
   *
   * Disabling the track only blanks the picture: the browser keeps the device
   * open, and its indicator light stays on. A teacher who has "turned the
   * camera off" is then still, as far as their laptop is concerned, being
   * filmed — which is not a cosmetic complaint, it is the difference between a
   * promise kept and a promise broken. Stopping the track is what actually
   * hands the camera back to the operating system and puts the light out.
   *
   * Coming back therefore needs a fresh capture, and the new track is given to
   * the SAME producer. replaceTrack swaps what the existing sender carries, so
   * the producer id students are consuming and the stream the server is
   * recording both continue uninterrupted. Closing and re-producing would make
   * every student renegotiate and would cut the recording in two.
   */
  const toggleCam = useCallback(async () => {
    if (role !== "teacher") {
      console.warn("[Mediasoup] only teacher can toggle camera");
      return;
    }
    // Acquiring a camera takes long enough to click the button again, and two
    // captures in flight would leave one of them owning the device forever.
    if (camBusyRef.current) return;
    camBusyRef.current = true;
    try {
      const next = !camOn;
      console.log("[Mediasoup] toggleCam", next);
      const audio = localStream ? localStream.getAudioTracks() : [];

      if (next) {
        const fresh = await navigator.mediaDevices.getUserMedia({
          video: camConstraints(profileRef.current),
        });
        const track = fresh.getVideoTracks()[0];
        if (!track) throw new Error("the camera returned no video track");
        if (producersRef.current.video) {
          await producersRef.current.video.replaceTrack({ track });
        } else if (sendTransportRef.current) {
          // No producer to swap into: the camera was refused or absent when
          // the meeting started, so this is the first one. Turning it on has
          // to publish rather than resume, otherwise the button would light up
          // over a camera nobody else can see.
          producersRef.current.video = await sendTransportRef.current.produce({
            track,
            ...camEncodings(profileRef.current),
            appData: { source: "video" },
          });
        }
        // A new MediaStream object, not a mutated one: the tile binds to the
        // object, so React has to be handed a different one to re-attach.
        // The audio track is carried across unchanged, so a muted mic stays
        // muted.
        const withCam = new MediaStream([...audio, track]);
        applyLocalStream(withCam);
        setTeacherStream(withCam);
        setCamOn(true);
        signalVideo("resume-producer");
      } else {
        // The device is released FIRST, before anything is said to the server.
        // Nothing can be sent from a stopped track anyway, so pausing first
        // bought nothing and risked everything: an acknowledgement that never
        // came would have left the camera running.
        for (const track of localStream ? localStream.getVideoTracks() : []) track.stop();
        const audioOnly = new MediaStream(audio);
        applyLocalStream(audioOnly);
        setTeacherStream(audioOnly);
        setCamOn(false);
        signalVideo("pause-producer");
      }
    } catch (err) {
      // Most often the camera is being held by another application, or
      // permission was withdrawn. The button must not be left claiming a
      // camera that is not on.
      console.error("[Mediasoup] toggleCam failed", err);
    } finally {
      camBusyRef.current = false;
    }
  }, [camOn, localStream, role, applyLocalStream]);

  /**
   * Captures this browser tab, and publishes it as the class stage.
   *
   * This is what makes a recording look like the lesson. The server used to
   * rebuild the picture from parts it understood -- strokes re-drawn from the
   * stroke list, the camera, a screen share -- which meant anything it could
   * not rebuild was simply missing: a pasted diagram, a PDF page, a document,
   * every piece of the interface around them.
   *
   * The teacher's own tab already shows all of it, correctly, because that is
   * the thing everyone is looking at. So it is captured and sent as one video,
   * and the recorder lays that down as the picture instead of assembling a
   * guess at it.
   *
   * Only while recording. It costs an uplink stream, and there is no reason to
   * pay for it when nothing is being kept.
   */
  const startStageCapture = useCallback(async () => {
    if (role !== "teacher" && role !== "coordinator") return false;
    if (producersRef.current.stage) return true;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser", frameRate: { max: 15 } },
        audio: false,
        // Chrome offers this tab first, so the teacher confirms rather than
        // hunting through a list of windows for the one they are looking at.
        preferCurrentTab: true,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("nothing was captured");
      // Text and diagrams, not motion: sharpness matters more than smoothness
      // for a page somebody is reading.
      try {
        track.contentHint = "detail";
      } catch (err) {
        console.warn("[Mediasoup] contentHint not supported", err.message);
      }
      const producer = await sendTransportRef.current.produce({
        track,
        ...stageEncodings(profileRef.current),
        appData: { source: "stage" },
      });
      producersRef.current.stage = producer;
      stageStreamRef.current = stream;
      // Stopping the capture from the browser's own bar ends the stage, and
      // the recording carries on with whatever else it has.
      track.onended = () => {
        stopStageCapture().catch((err) => console.error("[Mediasoup] stage end failed", err));
      };
      console.log("[Mediasoup] stage capture started");
      return true;
    } catch (err) {
      // A teacher who declines has not broken anything: the recording falls
      // back to the picture the server assembles itself.
      console.warn("[Mediasoup] stage capture refused", err.name || err.message);
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  const stopStageCapture = useCallback(async () => {
    const producer = producersRef.current.stage;
    if (!producer) return;
    try {
      await emitAck("close-producer", { source: "stage" });
    } catch (err) {
      console.error("[Mediasoup] closing the stage failed", err);
    }
    try {
      producer.close();
    } catch (err) {
      console.error("[Mediasoup] stage producer close failed", err);
    }
    producersRef.current.stage = null;
    releaseStream(stageStreamRef.current);
    stageStreamRef.current = null;
    console.log("[Mediasoup] stage capture stopped");
  }, [releaseStream]);

  /**
   * Ends both halves of a screen share.
   *
   * The picture and the sound are two producers, and stopping the share from
   * the browser's own bar ends only the track it owns -- without this, the
   * class would go on hearing a video whose picture had gone.
   */
  const stopScreenProducers = useCallback(async () => {
    for (const source of ["screen", "screen-audio"]) {
      const producer = producersRef.current[source];
      if (!producer) continue;
      try {
        await emitAck("close-producer", { source });
      } catch (err) {
        console.error(`[Mediasoup] close ${source} failed`, err);
      }
      try {
        producer.close();
      } catch (err) {
        console.error(`[Mediasoup] closing the ${source} producer failed`, err);
      }
      producersRef.current[source] = null;
    }
    releaseStream(localScreenRef.current);
    localScreenRef.current = null;
  }, [releaseStream]);

  /**
   * Shares a screen, and the sound coming out of it.
   *
   * This is how a video gets played to a class without uploading it anywhere:
   * whatever is playing on the teacher's machine is streamed live, picture and
   * sound together, in step by construction. Chrome offers the audio when a
   * browser TAB is chosen (and system sound on Windows for a whole screen); on
   * Firefox and Safari there may be no audio track at all, which is why its
   * absence is a log line rather than an error.
   *
   * The sound travels as its own producer rather than being mixed into the
   * teacher's microphone, so muting the teacher does not mute the video and the
   * recording can keep them apart.
   */
  const startScreen = useCallback(async ({ preferTab = false } = {}) => {
    try {
      if (role !== "teacher" && role !== "coordinator") throw new Error("Only teacher or coordinator can share screen");
      console.log("[Mediasoup] startScreen", { preferTab });
      const stream = await navigator.mediaDevices.getDisplayMedia({
        // Playing a video means sharing the tab it is in, so the picker opens
        // on tabs rather than on whole screens. A browser that does not know
        // this hint ignores it and shows its usual chooser.
        video: preferTab ? { displaySurface: "browser" } : true,
        // Asked for every time. A browser that will not give it simply returns
        // no audio track, and the share goes ahead silently rather than failing.
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        // Windows can hand over the whole machine's sound when a screen rather
        // than a tab is chosen. Ignored everywhere it means nothing.
        systemAudio: "include",
      });
      const track = stream.getVideoTracks()[0];
      /**
       * A tab playing a film and a tab showing a spreadsheet want opposite
       * things from an encoder, and it will act on being told which this is:
       * "motion" keeps a video smooth, "detail" keeps text readable.
       */
      try {
        track.contentHint = preferTab ? "motion" : "detail";
      } catch (err) {
        console.warn("[Mediasoup] contentHint not supported", err.message);
      }
      const producer = await sendTransportRef.current.produce({
        track,
        ...screenEncodings(profileRef.current),
        appData: { source: "screen" },
      });
      producersRef.current.screen = producer;
      localScreenRef.current = stream;

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        producersRef.current["screen-audio"] = await sendTransportRef.current.produce({
          track: audioTrack,
          appData: { source: "screen-audio" },
        });
        console.log("[Mediasoup] sharing screen WITH sound");
      } else {
        console.warn(
          "[Mediasoup] the screen was shared without sound — pick a browser tab and tick 'Share tab audio'",
        );
      }

      setScreenStream(stream);
      setSharing(true);
      // Stopping from the browser's own bar ends both halves of the share.
      track.onended = async () => {
        try {
          await stopScreenProducers();
          setSharing(false);
          setScreenStream(null);
        } catch (err) {
          console.error("[Mediasoup] screen ended cleanup failed", err);
        }
      };
    } catch (err) {
      console.error("[Mediasoup] startScreen failed", err);
      throw err;
    }
    // stopScreenProducers is stable; role is the only thing that decides
    // whether this is allowed to run at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  const stopScreen = useCallback(async () => {
    try {
      console.log("[Mediasoup] stopScreen");
      await stopScreenProducers();
      setSharing(false);
      setScreenStream(null);
    } catch (err) {
      console.error("[Mediasoup] stopScreen failed", err);
    }
  }, [stopScreenProducers]);

  /**
   * Everything read from a ref, and no dependencies.
   *
   * This is called from socket handlers that were registered once, so a
   * version of it that closed over state would go on stopping whatever was
   * current at mount -- which is how a meeting could end with the camera light
   * still on.
   */
  const cleanup = useCallback(() => {
    try {
      console.log("[Mediasoup] cleanup");
      releaseStream(localStreamRef.current);
      releaseStream(localScreenRef.current);
      releaseStream(stageStreamRef.current);
      releaseStream(screenStreamRef.current);
      localStreamRef.current = null;
      localScreenRef.current = null;
      stageStreamRef.current = null;
      setLocalStream(null);
      Object.values(producersRef.current).forEach((p) => {
        try {
          p.close();
        } catch (err) {
          console.error("[Mediasoup] close producer", err);
        }
      });
      sendTransportRef.current?.close();
      recvTransportRef.current?.close();
      remoteAudioRef.current.clear();
    } catch (err) {
      console.error("[Mediasoup] cleanup failed", err);
    }
  }, [releaseStream]);

  return {
    initDevice,
    consumeExisting,
    toggleMic,
    toggleCam,
    startScreen,
    stopScreen,
    cleanup,
    startStageCapture,
    stopStageCapture,
    localStream,
    teacherStream,
    screenStream,
    remoteAudio,
    micOn,
    camOn,
    sharing,
    ready,
  };
}
