import { useCallback, useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import { emitAck } from "../services/socket";

export function useMediasoup({ socket, role, enabled }) {
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  const producersRef = useRef({});
  const consumedRef = useRef(new Set());
  const pendingRef = useRef([]);
  const startingRef = useRef(false);
  const myPeerIdRef = useRef(null);
  const iceServersRef = useRef([]);

  const teacherMsRef = useRef(new MediaStream());
  const screenMsRef = useRef(new MediaStream());

  const [localStream, setLocalStream] = useState(null);
  const [teacherStream, setTeacherStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(role === "teacher");
  const [sharing, setSharing] = useState(false);
  const [ready, setReady] = useState(false);
  const [iceState, setIceState] = useState({ send: "new", recv: "new" });

  const bumpTeacher = () => {
    try {
      setTeacherStream(new MediaStream(teacherMsRef.current.getTracks()));
    } catch (err) {
      console.error("[Mediasoup] bumpTeacher failed", err);
    }
  };
  const bumpScreen = () => {
    try {
      setScreenStream(new MediaStream(screenMsRef.current.getTracks()));
    } catch (err) {
      console.error("[Mediasoup] bumpScreen failed", err);
    }
  };

  const attachRemoteTrack = useCallback((track, source) => {
    try {
      console.log("[Mediasoup] attachRemoteTrack", source, track.kind, track.id, track.readyState);
      const bucket = source === "screen" ? screenMsRef : teacherMsRef;
      bucket.current.getTracks().forEach((t) => {
        if (t.kind === track.kind) bucket.current.removeTrack(t);
      });
      bucket.current.addTrack(track);
      if (source === "screen") bumpScreen();
      else bumpTeacher();
    } catch (err) {
      console.error("[Mediasoup] attachRemoteTrack failed", err);
    }
  }, []);

  const consumeProducer = useCallback(
    async (producer) => {
      try {
        if (!producer || !producer.producerId) return;
        if (!deviceRef.current || !recvTransportRef.current) {
          pendingRef.current.push(producer);
          console.log("[Mediasoup] queued consume", producer);
          return;
        }
        if (myPeerIdRef.current && producer.peerId === myPeerIdRef.current) {
          console.log("[Mediasoup] skip own producer", producer);
          return;
        }
        if (producer.role === "student") {
          console.log("[Mediasoup] skip student producer (cam/audio first = teacher only)", producer);
          return;
        }
        if (consumedRef.current.has(producer.producerId)) return;
        consumedRef.current.add(producer.producerId);
        console.log("[Mediasoup] consumeProducer", producer);
        const res = await emitAck("consume", {
          producerId: producer.producerId,
          transportId: recvTransportRef.current.id,
          rtpCapabilities: deviceRef.current.rtpCapabilities,
        });
        const consumer = await recvTransportRef.current.consume({
          id: res.params.id,
          producerId: res.params.producerId,
          kind: res.params.kind,
          rtpParameters: res.params.rtpParameters,
        });
        attachRemoteTrack(consumer.track, producer.source || res.params.kind);
        await emitAck("resume-consumer", { consumerId: consumer.id });
      } catch (err) {
        consumedRef.current.delete(producer.producerId);
        console.error("[Mediasoup] consumeProducer failed", err);
      }
    },
    [attachRemoteTrack],
  );

  const startLocalMedia = useCallback(async () => {
    try {
      const md = navigator.mediaDevices;
      if (!md || typeof md.getUserMedia !== "function") {
        throw new Error(
          "Camera/mic blocked. Open https://59.96.57.40:5173/ (HTTPS required).",
        );
      }
      const constraints =
        role === "teacher"
          ? { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } }
          : { audio: true, video: false };
      console.log("[Mediasoup] getUserMedia", constraints);
      const stream = await md.getUserMedia(constraints);
      setLocalStream(stream);

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && sendTransportRef.current && !producersRef.current.audio) {
        producersRef.current.audio = await sendTransportRef.current.produce({
          track: audioTrack,
          encodings: [{ maxBitrate: 64000 }],
          appData: { source: "audio" },
        });
        console.log("[Mediasoup] audio producer created");
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && role === "teacher" && sendTransportRef.current && !producersRef.current.video) {
        producersRef.current.video = await sendTransportRef.current.produce({
          track: videoTrack,
          encodings: [{ maxBitrate: 800000 }],
          codecOptions: { videoGoogleStartBitrate: 400 },
          appData: { source: "video" },
        });
        setCamOn(true);
        console.log("[Mediasoup] video producer created");
      }
    } catch (err) {
      console.error("[Mediasoup] startLocalMedia failed", err);
      throw err;
    }
  }, [role]);

  const initDevice = useCallback(
    async ({ routerRtpCapabilities, iceServers, peerId }) => {
      try {
        if (startingRef.current || deviceRef.current) {
          console.log("[Mediasoup] initDevice already running/done");
          return;
        }
        startingRef.current = true;
        if (peerId) myPeerIdRef.current = peerId;
        iceServersRef.current = iceServers || [];
        console.log("[Mediasoup] initDevice", {
          peerId,
          iceServers: iceServersRef.current,
          secure: window.isSecureContext,
          hasMedia: Boolean(navigator.mediaDevices),
        });

        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities });
        deviceRef.current = device;

        const makeTransport = async (direction) => {
          const { params } = await emitAck("create-transport", { direction });
          console.log("[Mediasoup] transport params", direction, {
            id: params.id,
            iceCandidates: params.iceCandidates,
          });
          const transport =
            direction === "send"
              ? device.createSendTransport({
                  ...params,
                  iceServers: iceServersRef.current,
                  iceTransportPolicy: "all",
                })
              : device.createRecvTransport({
                  ...params,
                  iceServers: iceServersRef.current,
                  iceTransportPolicy: "all",
                });

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
                const res = await emitAck("produce", {
                  transportId: transport.id,
                  kind,
                  rtpParameters,
                  source: appData?.source || kind,
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
            setIceState((s) => ({ ...s, [direction]: state }));
            if (state === "failed") {
              console.error(
                "[Mediasoup] ICE failed. Office router must forward UDP/TCP 40000-49999 and 3478 to this server.",
              );
            }
          });
          transport.on("icegatheringstatechange", (state) => {
            console.log("[Mediasoup] ICE gathering", direction, state);
          });

          return transport;
        };

        sendTransportRef.current = await makeTransport("send");
        recvTransportRef.current = await makeTransport("recv");
        setReady(true);
        await startLocalMedia();
        for (const p of pendingRef.current.splice(0)) {
          await consumeProducer(p);
        }
      } catch (err) {
        startingRef.current = false;
        console.error("[Mediasoup] initDevice failed", err);
        throw err;
      }
    },
    [startLocalMedia, consumeProducer],
  );

  useEffect(() => {
    if (!socket || !enabled) return undefined;

    const onNew = (producer) => {
      console.log("[Mediasoup] new-producer", producer);
      consumeProducer(producer);
    };
    const onClosed = ({ producerId, source }) => {
      console.log("[Mediasoup] producer-closed", producerId, source);
      consumedRef.current.delete(producerId);
      if (source === "screen") {
        screenMsRef.current = new MediaStream();
        setScreenStream(null);
        setSharing(false);
      }
    };

    socket.on("new-producer", onNew);
    socket.on("producer-closed", onClosed);
    socket.on("force-mute", async () => {
      try {
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
      socket.off("force-mute");
    };
  }, [socket, enabled, consumeProducer, localStream]);

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
    try {
      const next = !micOn;
      localStream?.getAudioTracks().forEach((t) => {
        t.enabled = next;
      });
      await emitAck(next ? "resume-producer" : "pause-producer", { source: "audio" });
      setMicOn(next);
    } catch (err) {
      console.error("[Mediasoup] toggleMic failed", err);
    }
  }, [micOn, localStream]);

  const toggleCam = useCallback(async () => {
    try {
      if (role !== "teacher") return;
      const next = !camOn;
      localStream?.getVideoTracks().forEach((t) => {
        t.enabled = next;
      });
      await emitAck(next ? "resume-producer" : "pause-producer", { source: "video" });
      setCamOn(next);
    } catch (err) {
      console.error("[Mediasoup] toggleCam failed", err);
    }
  }, [camOn, localStream, role]);

  const startScreen = useCallback(async () => {
    try {
      if (role !== "teacher") throw new Error("Only teacher can share screen");
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = stream.getVideoTracks()[0];
      const producer = await sendTransportRef.current.produce({
        track,
        appData: { source: "screen" },
      });
      producersRef.current.screen = producer;
      setScreenStream(stream);
      setSharing(true);
      track.onended = async () => {
        try {
          await emitAck("close-producer", { source: "screen" });
          producer.close();
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
  }, [role]);

  const stopScreen = useCallback(async () => {
    try {
      await emitAck("close-producer", { source: "screen" });
      producersRef.current.screen?.close();
      screenStream?.getTracks().forEach((t) => t.stop());
      setSharing(false);
      setScreenStream(null);
    } catch (err) {
      console.error("[Mediasoup] stopScreen failed", err);
    }
  }, [screenStream]);

  const cleanup = useCallback(() => {
    try {
      localStream?.getTracks().forEach((t) => t.stop());
      screenStream?.getTracks().forEach((t) => t.stop());
      Object.values(producersRef.current).forEach((p) => {
        try {
          p.close();
        } catch (err) {
          console.error("[Mediasoup] close producer", err);
        }
      });
      sendTransportRef.current?.close();
      recvTransportRef.current?.close();
    } catch (err) {
      console.error("[Mediasoup] cleanup failed", err);
    }
  }, [localStream, screenStream]);

  return {
    initDevice,
    consumeExisting,
    toggleMic,
    toggleCam,
    startScreen,
    stopScreen,
    cleanup,
    localStream,
    teacherStream,
    screenStream,
    micOn,
    camOn,
    sharing,
    ready,
    iceState,
  };
}
